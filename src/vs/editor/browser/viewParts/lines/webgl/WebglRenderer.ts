/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { GlyphRenderer } from './GlyphRenderer';
import { acquireCharAtlas, removeTerminalFromCache } from './atlas/CharAtlasCache';
import { WebglCharAtlas } from './atlas/WebglCharAtlas';
import { RectangleRenderer } from './RectangleRenderer';
import { IWebGL2RenderingContext } from './Types';
import { RenderModel, RENDER_MODEL_BG_OFFSET, RENDER_MODEL_EXT_OFFSET, RENDER_MODEL_FG_OFFSET, RENDER_MODEL_INDICIES_PER_CELL } from './RenderModel';
import { Disposable } from 'vs/base/common/lifecycle';
import { observeDevicePixelDimensions } from 'vs/editor/browser/viewParts/lines/webgl/base/DevicePixelObserver';
import { IColorSet, IRenderDimensions, IRequestRedrawEvent } from 'vs/editor/browser/viewParts/lines/webgl/base/Types';
import { Emitter } from 'vs/base/common/event';
import { NULL_CELL_CODE, Attributes, FgFlags, BgFlags } from 'vs/editor/browser/viewParts/lines/webgl/base/Constants';
import { ViewportData } from 'vs/editor/common/viewLayout/viewLinesViewportData';
import { ViewLineRenderingData } from 'vs/editor/common/viewModel';
import { FontInfo } from 'vs/editor/common/config/fontInfo';
import { EditorLayoutInfo, EditorOption } from 'vs/editor/common/config/editorOptions';
import * as viewEvents from 'vs/editor/common/viewEvents';
import { ViewContext } from 'vs/editor/common/viewModel/viewContext';
import { TokenizationRegistry } from 'vs/editor/common/languages';
import { AttributeData } from 'vs/editor/browser/viewParts/lines/webgl/base/AttributeData';
import { ITokenPresentation } from 'vs/editor/common/encodedTokenAttributes';
import { Color } from 'vs/base/common/color';

/** Work variables to avoid garbage collection. */
// const w: { fg: number; bg: number; hasFg: boolean; hasBg: boolean; isSelected: boolean } = {
// 	fg: 0,
// 	bg: 0,
// 	hasFg: false,
// 	hasBg: false,
// 	isSelected: false
// };

export class WebglRenderer extends Disposable {
	private _charAtlas: WebglCharAtlas | undefined;
	private _devicePixelRatio: number;

	private _model: RenderModel = new RenderModel();
	// private _workCell: CellData = new CellData();
	// private _workColors: { fg: number; bg: number; ext: number } = { fg: 0, bg: 0, ext: 0 };

	private _canvas: HTMLCanvasElement;
	private _gl: IWebGL2RenderingContext;
	private _rectangleRenderer!: RectangleRenderer;
	private _glyphRenderer!: GlyphRenderer;

	public dimensions: IRenderDimensions;

	// private _core: { cols: number; rows: number };
	private _charSize = { width: 10, height: 20 };
	private _isAttached: boolean;
	// private _contextRestorationTimeout: number | undefined;

	private _onChangeTextureAtlas = new Emitter<HTMLCanvasElement>();
	public get onChangeTextureAtlas() { return this._onChangeTextureAtlas.event; }
	private _onRequestRedraw = new Emitter<IRequestRedrawEvent>();
	public get onRequestRedraw() { return this._onRequestRedraw.event; }

	private _onContextLoss = new Emitter<void>();
	public get onContextLoss() { return this._onContextLoss.event; }

	constructor(
		private readonly _context: ViewContext,
		private _viewportDims: {
			cols: number;
			rows: number;
			options: {
				lineHeight: number;
				letterSpacing: number;
			};
		},
		private _colors: IColorSet,
		private readonly _screenElement: HTMLElement,
		preserveDrawingBuffer?: boolean
	) {
		super();

		// this._core = (this._viewportDims as any)._core;

		this.dimensions = {
			scaledCharWidth: 0,
			scaledCharHeight: 0,
			scaledCellWidth: 0,
			scaledCellHeight: 0,
			scaledCharLeft: 0,
			scaledCharTop: 0,
			scaledCanvasWidth: 0,
			scaledCanvasHeight: 0,
			canvasWidth: 0,
			canvasHeight: 0,
			actualCellWidth: 0,
			actualCellHeight: 0
		};
		this._devicePixelRatio = window.devicePixelRatio;

		const options = this._context.configuration.options;
		const layoutInfo = options.get(EditorOption.layoutInfo);
		this._updateDimensions(layoutInfo);

		this._canvas = document.createElement('canvas');

		const contextAttributes = {
			antialias: false,
			depth: false,
			preserveDrawingBuffer
		};
		this._gl = this._canvas.getContext('webgl2', contextAttributes) as IWebGL2RenderingContext;
		if (!this._gl) {
			throw new Error('WebGL2 not supported ' + this._gl);
		}

		// this.register(addDisposableDomListener(this._canvas, 'webglcontextlost', (e) => {
		// 	console.log('webglcontextlost event received');
		// 	// Prevent the default behavior in order to enable WebGL context restoration.
		// 	e.preventDefault();
		// 	// Wait a few seconds to see if the 'webglcontextrestored' event is fired.
		// 	// If not, dispatch the onContextLoss notification to observers.
		// 	this._contextRestorationTimeout = setTimeout(() => {
		// 		this._contextRestorationTimeout = undefined;
		// 		console.warn('webgl context not restored; firing onContextLoss');
		// 		this._onContextLoss.fire(e);
		// 	}, 3000 /* ms */);
		// }));
		// this.register(addDisposableDomListener(this._canvas, 'webglcontextrestored', (e) => {
		// 	console.warn('webglcontextrestored event received');
		// 	clearTimeout(this._contextRestorationTimeout);
		// 	this._contextRestorationTimeout = undefined;
		// 	// The texture atlas and glyph renderer must be fully reinitialized
		// 	// because their contents have been lost.
		// 	removeTerminalFromCache(this._terminal);
		// 	this._initializeWebGLState();
		// 	this._requestRedrawViewport();
		// }));

		this._register(observeDevicePixelDimensions(this._canvas, window, (w, h) => this._setCanvasDevicePixelDimensions(w, h)));

		this._screenElement.appendChild(this._canvas);

		this._initializeWebGLState();

		this._isAttached = window.document.body.contains(this._screenElement);
	}

	public override dispose(): void {
		super.dispose();
		this._canvas.parentElement?.removeChild(this._canvas);
		removeTerminalFromCache(this);
		super.dispose();
	}

	public get textureAtlas(): HTMLCanvasElement | undefined {
		return this._charAtlas?.cacheCanvas;
	}

	public setColors(colors: IColorSet): void {
		this._colors = colors;

		this._rectangleRenderer.setColors();

		const options = this._context.configuration.options;
		const fontInfo = options.get(EditorOption.fontInfo);
		this._refreshCharAtlas(fontInfo);

		// Force a full refresh
		this._clearModel(true);
	}

	public onDevicePixelRatioChange(): void {
		// If the device pixel ratio changed, the char atlas needs to be regenerated
		// and the terminal needs to refreshed
		if (this._devicePixelRatio !== window.devicePixelRatio) {
			this._devicePixelRatio = window.devicePixelRatio;
			this.onResize();
		}
	}

	public onResize(): void {
		const options = this._context.configuration.options;
		const fontInfo = options.get(EditorOption.fontInfo);
		const layoutInfo = options.get(EditorOption.layoutInfo);

		// Update character and canvas dimensions
		this._updateDimensions(layoutInfo);

		this._model.resize(this._viewportDims.cols, this._viewportDims.rows);

		// Resize the canvas
		this._canvas.width = this.dimensions.scaledCanvasWidth;
		this._canvas.height = this.dimensions.scaledCanvasHeight;
		this._canvas.style.width = `${this.dimensions.canvasWidth}px`;
		this._canvas.style.height = `${this.dimensions.canvasHeight}px`;

		// Resize the screen
		this._screenElement.style.width = `${this.dimensions.canvasWidth}px`;
		this._screenElement.style.height = `${this.dimensions.canvasHeight}px`;

		this._rectangleRenderer.setDimensions(this.dimensions);
		this._rectangleRenderer.onResize();
		this._glyphRenderer.setDimensions(this.dimensions);
		this._glyphRenderer.onResize();

		this._refreshCharAtlas(fontInfo);

		// Force a full refresh. Resizing `_glyphRenderer` should clear it already,
		// so there is no need to clear it again here.
		this._clearModel(false);
	}

	public onCharSizeChanged(): void {
		this.onResize();
	}

	public onBlur(): void {
		// Request a redraw for active/inactive selection background
		this._requestRedrawViewport();
	}

	public onFocus(): void {
		// Request a redraw for active/inactive selection background
		this._requestRedrawViewport();
	}

	public onSelectionChanged(start: [number, number] | undefined, end: [number, number] | undefined, columnSelectMode: boolean): void {
		this._updateSelectionModel(start, end, columnSelectMode);
		this._requestRedrawViewport();
	}

	public onCursorMove(): void {
	}

	/**
	 * Initializes members dependent on WebGL context state.
	 */
	private _initializeWebGLState(): void {
		// Dispose any previous rectangle and glyph renderers before creating new ones.
		this._rectangleRenderer?.dispose();
		this._glyphRenderer?.dispose();

		this._rectangleRenderer = new RectangleRenderer(this._viewportDims, this._colors, this._gl, this.dimensions);
		this._glyphRenderer = new GlyphRenderer(this._viewportDims, this._gl, this.dimensions);

		// Update dimensions and acquire char atlas
		this.onCharSizeChanged();
	}

	/**
	 * Refreshes the char atlas, aquiring a new one if necessary.
	 * @param terminal The terminal.
	 * @param colorSet The color set to use for the char atlas.
	 */
	private _refreshCharAtlas(fontInfo: FontInfo): void {
		if (this.dimensions.scaledCharWidth <= 0 && this.dimensions.scaledCharHeight <= 0) {
			// Mark as not attached so char atlas gets refreshed on next render
			this._isAttached = false;
			return;
		}

		const atlas = acquireCharAtlas(this, this._colors, this.dimensions.scaledCellWidth, this.dimensions.scaledCellHeight, this.dimensions.scaledCharWidth, this.dimensions.scaledCharHeight, window.devicePixelRatio, this._viewportDims.options.lineHeight, fontInfo);
		if (!('getRasterizedGlyph' in atlas)) {
			throw new Error('The webgl renderer only works with the webgl char atlas');
		}
		if (this._charAtlas !== atlas) {
			this._onChangeTextureAtlas.fire(atlas.cacheCanvas);
		}
		this._charAtlas = atlas;
		this._charAtlas.warmUp();
		this._glyphRenderer.setAtlas(this._charAtlas);
	}

	/**
	 * Clear the model.
	 * @param clearGlyphRenderer Whether to also clear the glyph renderer. This
	 * should be true generally to make sure it is in the same state as the model.
	 */
	private _clearModel(clearGlyphRenderer: boolean): void {
		this._model.clear();
		if (clearGlyphRenderer) {
			this._glyphRenderer.clear();
		}
	}

	public clearCharAtlas(): void {
		this._charAtlas?.clearTexture();
		this._clearModel(true);
		// TODO: Verify this works
		// this._updateModel(0, this._viewportDims.rows - 1);
		this._requestRedrawViewport();
	}

	public clear(): void {
		this._clearModel(true);
	}

	public renderRows(start: number, end: number, viewportData: ViewportData): void {
		if (!this._isAttached) {
			if (window.document.body.contains(this._screenElement) && this._charSize.width && this._charSize.height) {
				const options = this._context.configuration.options;
				const fontInfo = options.get(EditorOption.fontInfo);
				const layoutInfo = options.get(EditorOption.layoutInfo);
				this._updateDimensions(layoutInfo);
				this._refreshCharAtlas(fontInfo);
				this._isAttached = true;
			} else {
				return;
			}
		}

		// Tell renderer the frame is beginning
		if (this._glyphRenderer.beginFrame()) {
			this._clearModel(true);
			this._updateSelectionModel(undefined, undefined);
		}

		// Update model to reflect what's drawn
		this._updateModel(start, end, viewportData);

		// Render
		this._rectangleRenderer.render();
		this._glyphRenderer.render(this._model);
	}

	private _updateModel(start: number, end: number, viewportData: ViewportData): void {
		let i, x, y: number;
		let chars: string;
		let row, code, tokenId, fg, bg: number;
		let presentation: ITokenPresentation;
		let tokenColor: Color;
		let lineRenderingData: ViewLineRenderingData;

		const colorMap = TokenizationRegistry.getColorMap() ?? [];
		const ydisp = start;
		end -= start;
		start = 0;
		for (y = start; y <= end - start; y++) {
			row = y + ydisp;
			// Convert 0- to 1-based
			lineRenderingData = viewportData.getViewLineRenderingData(row + 1);
			this._model.lineLengths[y] = 0;
			for (x = 0; x < lineRenderingData.maxColumn; x++) {
				chars = lineRenderingData.content[x];
				if (chars === undefined) {
					continue;
				}

				tokenId = lineRenderingData.tokens.findTokenIndexAtOffset(x);
				presentation = lineRenderingData.tokens.getPresentation(tokenId);
				tokenColor = colorMap[presentation.foreground];

				fg = tokenColor ? Attributes.CM_RGB | AttributeData.fromColorRGB([tokenColor.rgba.r, tokenColor.rgba.g, tokenColor.rgba.b]) : 0;
				bg = 0;

				if (presentation.bold) {
					fg |= FgFlags.BOLD;
				}
				if (presentation.italic) {
					bg |= BgFlags.ITALIC;
				}

				code = chars.charCodeAt(0);
				if (code !== NULL_CELL_CODE) {
					this._model.lineLengths[y] = x + 1;
				}
				i = ((y * this._viewportDims.cols) + x) * RENDER_MODEL_INDICIES_PER_CELL;
				this._model.cells[i] = code;
				this._model.cells[i + RENDER_MODEL_BG_OFFSET] = bg; //this._workColors.bg;
				this._model.cells[i + RENDER_MODEL_FG_OFFSET] = fg;
				this._model.cells[i + RENDER_MODEL_EXT_OFFSET] = 0; //this._workColors.ext;
				this._glyphRenderer.updateCell(x, y, code, bg, fg, 0, chars, 0);
			}
		}

		// Clear remaining line lengths to support overscroll properly
		for (; y < this._model.lineLengths.length; y++) {
			this._model.lineLengths[y] = 0;
		}

		this._rectangleRenderer.updateBackgrounds(this._model);
	}

	private _updateSelectionModel(start: [number, number] | undefined, end: [number, number] | undefined, columnSelectMode: boolean = false): void {
		// const terminal = this._viewportDims;

		// Selection does not exist
		if (!start || !end || (start[0] === end[0] && start[1] === end[1])) {
			this._model.clearSelection();
			return;
		}

		return;

		// // Translate from buffer position to viewport position
		// const viewportStartRow = start[1] - terminal.buffer.active.viewportY;
		// const viewportEndRow = end[1] - terminal.buffer.active.viewportY;
		// const viewportCappedStartRow = Math.max(viewportStartRow, 0);
		// const viewportCappedEndRow = Math.min(viewportEndRow, terminal.rows - 1);

		// // No need to draw the selection
		// if (viewportCappedStartRow >= terminal.rows || viewportCappedEndRow < 0) {
		// 	this._model.clearSelection();
		// 	return;
		// }

		// this._model.selection.hasSelection = true;
		// this._model.selection.columnSelectMode = columnSelectMode;
		// this._model.selection.viewportStartRow = viewportStartRow;
		// this._model.selection.viewportEndRow = viewportEndRow;
		// this._model.selection.viewportCappedStartRow = viewportCappedStartRow;
		// this._model.selection.viewportCappedEndRow = viewportCappedEndRow;
		// this._model.selection.startCol = start[0];
		// this._model.selection.endCol = end[0];
	}

	private _updateDimensions(layoutInfo: EditorLayoutInfo) {
		// Perform a new measure if the CharMeasure dimensions are not yet available
		if (!this._charSize.width || !this._charSize.height) {
			return;
		}

		this._charSize.width = 8;
		this._charSize.height = 12;

		this._viewportDims.cols = Math.ceil(layoutInfo.width / this._charSize.width);
		this._viewportDims.rows = Math.ceil(layoutInfo.height / this._charSize.height);

		// Calculate the scaled character width. Width is floored as it must be drawn to an integer grid
		// in order for the char atlas glyphs to not be blurry.
		this.dimensions.scaledCharWidth = Math.floor(this._charSize.width * this._devicePixelRatio);

		// Calculate the scaled character height. Height is ceiled in case devicePixelRatio is a
		// floating point number in order to ensure there is enough space to draw the character to the
		// cell.
		this.dimensions.scaledCharHeight = Math.ceil(this._charSize.height * this._devicePixelRatio);

		// Calculate the scaled cell height, if lineHeight is _not_ 1, the resulting value will be
		// floored since lineHeight can never be lower then 1, this guarentees the scaled cell height
		// will always be larger than scaled char height.
		this.dimensions.scaledCellHeight = Math.floor(this.dimensions.scaledCharHeight * this._viewportDims.options.lineHeight);

		// Calculate the y offset within a cell that glyph should draw at in order for it to be centered
		// correctly within the cell.
		this.dimensions.scaledCharTop = this._viewportDims.options.lineHeight === 1 ? 0 : Math.round((this.dimensions.scaledCellHeight - this.dimensions.scaledCharHeight) / 2);

		// Calculate the scaled cell width, taking the letterSpacing into account.
		this.dimensions.scaledCellWidth = this.dimensions.scaledCharWidth + Math.round(this._viewportDims.options.letterSpacing);

		// Calculate the x offset with a cell that text should draw from in order for it to be centered
		// correctly within the cell.
		this.dimensions.scaledCharLeft = Math.floor(this._viewportDims.options.letterSpacing / 2);

		// Recalculate the canvas dimensions, the scaled dimensions define the actual number of pixel in
		// the canvas
		this.dimensions.scaledCanvasHeight = this._viewportDims.rows * this.dimensions.scaledCellHeight;
		this.dimensions.scaledCanvasWidth = this._viewportDims.cols * this.dimensions.scaledCellWidth;

		// The the size of the canvas on the page. It's important that this rounds to nearest integer
		// and not ceils as browsers often have floating point precision issues where
		// `window.devicePixelRatio` ends up being something like `1.100000023841858` for example, when
		// it's actually 1.1. Ceiling may causes blurriness as the backing canvas image is 1 pixel too
		// large for the canvas element size.
		this.dimensions.canvasHeight = Math.round(this.dimensions.scaledCanvasHeight / this._devicePixelRatio);
		this.dimensions.canvasWidth = Math.round(this.dimensions.scaledCanvasWidth / this._devicePixelRatio);

		// Get the CSS dimensions of an individual cell. This needs to be derived from the calculated
		// device pixel canvas value above. CharMeasure.width/height by itself is insufficient when the
		// page is not at 100% zoom level as CharMeasure is measured in CSS pixels, but the actual char
		// size on the canvas can differ.
		this.dimensions.actualCellHeight = this.dimensions.scaledCellHeight / this._devicePixelRatio;
		this.dimensions.actualCellWidth = this.dimensions.scaledCellWidth / this._devicePixelRatio;
	}

	private _setCanvasDevicePixelDimensions(width: number, height: number): void {
		if (this._canvas.width === width && this._canvas.height === height) {
			return;
		}
		// While the actual canvas size has changed, keep scaledCanvasWidth/Height as the value before
		// the change as it's an exact multiple of the cell sizes.
		this._canvas.width = width;
		this._canvas.height = height;
		this._requestRedrawViewport();
	}

	private _requestRedrawViewport(): void {
		this._onRequestRedraw.fire({ start: 0, end: this._viewportDims.rows - 1 });
	}

	public onConfigurationChanged(e: viewEvents.ViewConfigurationChangedEvent): boolean {
		const options = this._context.configuration.options;
		const fontInfo = options.get(EditorOption.fontInfo);
		// TODO: Wrapping
		// const wrappingInfo = options.get(EditorOption.wrappingInfo);
		const layoutInfo = options.get(EditorOption.layoutInfo);

		this._updateDimensions(layoutInfo);
		this._refreshCharAtlas(fontInfo);
		return true;
	}

	private _lastScrollWidth: number = 0;
	private _lastScrollHeight: number = 0;
	public onScrollChanged(e: viewEvents.ViewScrollChangedEvent): boolean {
		if (e.scrollWidth !== this._lastScrollWidth || e.scrollHeight !== this._lastScrollHeight) {
			this._lastScrollWidth = e.scrollWidth;
			this._lastScrollHeight = e.scrollHeight;
			this.onResize();
		}
		if (e.scrollTopChanged) {
			const cssPixelOffset = e.scrollTop % Math.floor(this.dimensions.actualCellHeight);
			const clipspaceOffset = cssPixelOffset / this.dimensions.canvasHeight;
			this._glyphRenderer.setOffset(clipspaceOffset);
			this._rectangleRenderer.setOffset(clipspaceOffset);
		}
		return true;
	}

}