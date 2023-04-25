import * as common from './common.mjs';
import * as locale from '../../shared/sauce/locale.mjs';

const H = locale.human;
const svgInternalScale = 0.01;


let idle;
if (window.requestIdleCallback) {
    idle = options => new Promise(resolve => requestIdleCallback(resolve, options));
} else {
    idle = () => new Promise(resolve => setTimeout(resolve, 10 + 1000 * Math.random()));
}


function createElementSVG(name, attrs={}) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, value);
    }
    return el;
}


function createElement(name, attrs={}) {
    const el = document.createElement(name);
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, value);
    }
    return el;
}


function controlPoint(cur, prev, next, reverse, smoothing) {
    prev ||= cur;
    next ||= cur;
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const distance = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) + (reverse ? Math.PI : 0);
    const length = distance * smoothing;
    return [cur[0] + Math.cos(angle) * length, cur[1] + Math.sin(angle) * length];
}


function smoothPath(points, {loop, smoothing=0.2}={}) {
    const path = ['M' + points[0].join()];
    if (loop) {
        for (let i = 1; i < points.length + 1; i++) {
            const prevPrev = points.at(i - 2);
            const prev = points.at(i - 1);
            const cur = points[i % points.length];
            const next = points.at((i + 1) % points.length);
            const cpStart = controlPoint(prev, prevPrev, cur, false, smoothing);
            const cpEnd = controlPoint(cur, prev, next, true, smoothing);
            path.push('C' + [cpStart.join(), cpEnd.join(), cur.join()].join(' '));
        }
    } else {
        for (let i = 1; i < points.length; i++) {
            const cpStart = controlPoint(points[i - 1], points[i - 2], points[i], false, smoothing);
            const cpEnd = controlPoint(points[i], points[i - 1], points[i + 1], true, smoothing);
            path.push('C' + [cpStart.join(), cpEnd.join(), points[i].join()].join(' '));
        }
    }
    return path.join('');
}


function isVisible() {
    return document.visibilityState === 'visible';
}


class Transition {

    EPSILON = 1 / 0x800000;

    constructor({duration=1000}={}) {
        this.duration = duration;
        this.disabled = false;
        this._src = undefined;
        this._cur = [];
        this._dst = undefined;
        this._startTime = 0;
        this._endTime = 0;
        this._disabledRefCnt = 0;
        this.disabled = false;
        this.playing = false;
    }

    now() {
        return performance.now();
    }

    incDisabled() {
        this._disabledRefCnt++;
        if (this._disabledRefCnt === 1) {
            this.disabled = true;
            this.playing = false;
            this._dst = Array.from(this._cur);
            this._startTime = this._endTime = 0;
        }
    }

    decDisabled() {
        this._disabledRefCnt--;
        if (this._disabledRefCnt < 0) {
            throw new Error("Transition disabled refcnt < 0");
        }
        if (this._disabledRefCnt === 0) {
            this.disabled = false;
            if (this.playing && this._remainingTime) {
                const now = this.now();
                this._startTime = now;
                this._endTime = now + this._remainingTime;
            }
            this._remainingTime = null;
        }
    }

    setDuration(duration) {
        if (!this.disabled) {
            this._recalcCurrent();
            if (this.playing) {
                // Prevent jitter by forwarding the current transition.
                this._src = Array.from(this._cur);
                this._startTime = this.now();
                this._endTime += duration - this.duration;
            }
        }
        this.duration = duration;
    }

    setValues(values) {
        if (!this.disabled) {
            if (this._dst) {
                const now = this.now();
                if (now < this._endTime) {
                    // Start from current position (and prevent Zeno's paradaox)
                    this._recalcCurrent();
                    this._src = this._cur.map((x, i) =>
                        Math.abs(values[i] - x) < this.EPSILON ? values[i] : x);
                } else {
                    // Start from last position.
                    this._src = this._dst;
                }
                this._startTime = now;
                this._endTime = now + this.duration;
                this.playing = true;
            }
            this._cur.length = values.length;
        } else {
            this._cur = Array.from(values);
        }
        this._dst = Array.from(values);
    }

    getStep() {
        if (this.disabled) {
            // Return the last used position
            return this._cur;
        } else if (this.playing) {
            this._recalcCurrent();
            return this._cur;
        } else if (this._dst) {
            return this._dst;
        }
    }

    _recalcCurrent() {
        const now = this.now();
        const progress = (now - this._startTime) / (this._endTime - this._startTime);
        if (progress >= 1 || this.disabled) {
            if (this._dst) {
                this._cur = this._dst;
            }
            this.playing = false;
        } else {
            for (let i = 0; i < this._dst.length; i++) {
                const delta = this._dst[i] - this._src[i];
                this._cur[i] = this._src[i] + (delta * progress);
            }
        }
    }
}


export class SauceZwiftMap extends EventTarget {
    constructor({el, worldList, zoom=1, zoomMin=0.25, zoomMax=4.5, autoHeading=true,
                 style='default', opacity=1, tiltShift=null, maxTiltShiftAngle=65,
                 sparkle=false, quality=1, verticalOffset=0, fpsLimit=60,
                 zoomPriorityTilt=true}) {
        super();
        el.classList.add('sauce-map-container');
        this.el = el;
        this.worldList = worldList;
        this.zoomMin = zoomMin;
        this.zoomMax = zoomMax;
        this.maxTiltShiftAngle = maxTiltShiftAngle;
        this.watchingId = null;
        this.athleteId = null;
        this.courseId = null;
        this.roadId = null;
        this.worldMeta = null;
        this.adjHeading = 0;
        this._headingRotations = 0;
        this._lastHeading = 0;
        this._headingOfft = 0;
        this._athleteCache = new Map();
        this._ents = new Map();
        this._pendingEntityUpdates = new Set();
        this._centerXY = [0, 0];
        this._anchorXY = [0, 0];
        this._dragXY = [0, 0];
        this._layerScale = null;
        this._pauseRefCnt = 0;
        this._pinned = new Set();
        this._mapFinalScale = null;
        this._lastFrameTime = 0;
        this._wheelState = {
            nextAnimFrame: null,
            done: null,
        };
        this._pointerState = {
            nextAnimFrame: null,
            lastDistance: null,
            ev1: null,
            ev2: null,
            lastX: null,
            lastY: null,
        };
        this._transformAnimationLoopBound = this._transformAnimationLoop.bind(this);
        this._onPointerMoveBound = this._onPointerMove.bind(this);
        this._onPointerDoneBound = this._onPointerDone.bind(this);
        this._mapTransition = new Transition({duration: 500});
        this._elements = {
            map: createElement('div', {class: 'sauce-map'}),
            mapCanvas: createElement('canvas', {class: 'map-background'}),
            ents: createElement('div', {class: 'entities'}),
            pins: createElement('div', {class: 'pins'}),
            roads: createElementSVG('svg', {class: 'roads'}),
            roadLayers: {
                defs: createElementSVG('defs'),
                gutters: createElementSVG('g', {class: 'gutters'}),
                surfacesLow: createElementSVG('g', {class: 'surfaces low'}),
                surfacesMid: createElementSVG('g', {class: 'surfaces mid'}),
                surfacesHigh: createElementSVG('g', {class: 'suffaces high'}),
            }
        };
        this._elements.roads.append(...Object.values(this._elements.roadLayers));
        this._elements.map.append(this._elements.mapCanvas, this._elements.roads,
                                  this._elements.ents);
        this.el.addEventListener('wheel', this._onWheelZoom.bind(this));
        this.el.addEventListener('pointerdown', this._onPointerDown.bind(this));
        this._elements.ents.addEventListener('click', this._onEntsClick.bind(this));
        this.incPause();
        this.setZoom(zoom);
        this.setAutoHeading(autoHeading);
        this.setStyle(style);
        this.setOpacity(opacity);
        this.setTiltShift(tiltShift);
        this.setZoomPriorityTilt(zoomPriorityTilt);
        this.setSparkle(sparkle);
        this.setQuality(quality);
        this.setVerticalOffset(verticalOffset);
        this.setFPSLimit(fpsLimit);
        this._resizeObserver = new ResizeObserver(([x]) => this._elHeight = x.contentRect.height);
        this._resizeObserver.observe(this.el);
        this.el.append(this._elements.map, this._elements.pins);
        this._elHeight = this.el.clientHeight;
        this.decPause();
        this._gcLoop();
        requestAnimationFrame(this._transformAnimationLoopBound);
    }

    setFPSLimit(fps) {
        this.fpsLimit = fps;
        this._msPerFrame = 1000 / fps | 0;
    }

    setStyle(style) {
        this.style = style || 'default';
        if (!this.isPaused()) {
            this._updateMapBackground();
        }
    }

    setOpacity(v) {
        this._elements.mapCanvas.style.setProperty('--opacity', isNaN(v) ? 1 : v);
    }

    _fullUpdateAsNeeded() {
        if (!this.isPaused()) {
            if (!this._adjustLayerScale()) {
                this._updateGlobalTransform({render: true});
            }
            return true;
        }
        return false;
    }

    setTiltShift(v) {
        v = v || null;
        this._tiltShift = v;
        this._fullUpdateAsNeeded();
    }

    setZoomPriorityTilt(en) {
        this._zoomPrioTilt = en;
        this._fullUpdateAsNeeded();
    }

    setSparkle(en) {
        this.el.classList.toggle('sparkle', !!en);
    }

    setQuality(q) {
        this.quality = q;
        this._fullUpdateAsNeeded();
    }

    setVerticalOffset(v) {
        this.verticalOffset = v;
        if (!this.isPaused()) {
            this._updateGlobalTransform({render: true});
        }
    }

    setZoom(zoom) {
        this.zoom = zoom;
        this._applyZoom();
    }

    _adjustZoom(adj) {
        this.zoom = Math.max(this.zoomMin, Math.min(this.zoomMax, this.zoom + adj));
    }

    _applyZoom() {
        this._elements.map.style.setProperty('--zoom', this.zoom);
        if (this._fullUpdateAsNeeded()) {
            const ev = new Event('zoom');
            ev.zoom = this.zoom;
            this.dispatchEvent(ev);
        }
    }

    _onWheelZoom(ev) {
        if (!ev.deltaY) {
            return;
        }
        ev.preventDefault();
        this.trackingPaused = true;
        this._adjustZoom(-ev.deltaY / 2000 * this.zoom);
        cancelAnimationFrame(this._wheelState.nextAnimFrame);
        this._wheelState.nextAnimFrame = requestAnimationFrame(() => {
            if (this._wheelState.done) {
                clearTimeout(this._wheelState.done);
            } else {
                this._mapTransition.incDisabled();
            }
            this._applyZoom();
            // Lazy re-enable of animations to avoid need for forced paint
            this._wheelState.done = setTimeout(() => {
                this.trackingPaused = false;
                this._wheelState.done = null;
                this._mapTransition.decDisabled();
            }, 100);
        });
    }

    _onPointerDown(ev) {
        const state = this._pointerState;
        if (ev.button !== 0 || (state.ev1 && state.ev2)) {
            return;
        }
        if (state.ev1) {
            state.ev2 = ev;
            this.el.classList.remove('moving');
            state.lastDistance = Math.sqrt(
                (ev.pageX - state.ev1.pageX) ** 2 +
                (ev.pageY - state.ev1.pageY) ** 2);
            return;
        } else {
            state.ev1 = ev;
        }
        state.active = false;
        state.lastX  = ev.pageX;
        state.lastY = ev.pageY;
        document.addEventListener('pointermove', this._onPointerMoveBound);
        document.addEventListener('pointerup', this._onPointerDoneBound, {once: true});
        document.addEventListener('pointercancel', this._onPointerDoneBound, {once: true});
    }

    setDragOffset(x, y) {
        this._dragXY[0] = x;
        this._dragXY[1] = y;
        if (!this.isPaused()) {
            this._updateGlobalTransform({render: true});
            const dragEv = new Event('drag');
            dragEv.drag = [x, y];
            this.dispatchEvent(dragEv);
        }
    }

    setAutoHeading(en) {
        if (!en) {
            this._setHeading(0);
        }
        this.autoHeading = en;
        if (!this.isPaused()) {
            this._updateGlobalTransform({render: true});
        }
    }

    _onPointerMove(ev) {
        const state = this._pointerState;
        if (!state.active) {
            state.active = true;
            this.trackingPaused = true;
            this.el.classList.add('moving');
            this._mapTransition.incDisabled();
        }
        if (!state.ev2) {
            this._handlePointerDragEvent(ev, state);
        } else {
            this._handlePointerPinchEvent(ev, state);
        }
    }

    _handlePointerDragEvent(ev, state) {
        cancelAnimationFrame(state.nextAnimFrame);
        state.nextAnimFrame = requestAnimationFrame(() => {
            const deltaX = ev.pageX - state.lastX;
            const deltaY = ev.pageY - state.lastY;
            state.lastX = ev.pageX;
            state.lastY = ev.pageY;
            const x = this._dragXY[0] + (deltaX / this.zoom);
            const y = this._dragXY[1] + (deltaY / this.zoom);
            this.setDragOffset(x, y);
        });
    }

    _handlePointerPinchEvent(ev, state) {
        let otherEvent;
        if (ev.pointerId === state.ev1.pointerId) {
            otherEvent = state.ev2;
            state.ev1 = ev;
        } else if (ev.pointerId === state.ev2.pointerId) {
            otherEvent = state.ev1;
            state.ev2 = ev;
        } else {
            // third finger, ignore
            return;
        }
        const distance = Math.sqrt(
            (ev.pageX - otherEvent.pageX) ** 2 +
            (ev.pageY - otherEvent.pageY) ** 2);
        const deltaDistance = distance - state.lastDistance;
        state.lastDistance = distance;
        this._adjustZoom(deltaDistance / 600);
        requestAnimationFrame(() => this._applyZoom());
    }

    _onPointerDone(ev) {
        const state = this._pointerState;
        if (state.active) {
            this.el.classList.remove('moving');
            this._mapTransition.decDisabled();
            state.active = false;
        }
        document.removeEventListener('pointermove', this._onPointerMoveBound);
        document.removeEventListener('pointerup', this._onPointerDoneBound, {once: true});
        document.removeEventListener('pointercancel', this._onPointerDoneBound, {once: true});
        this._pointerState.ev1 = this._pointerState.ev2 = null;
        this.trackingPaused = false;
    }

    async _updateMapBackground() {
        const suffix = {
            default: '',
            neon: '-neon',
        }[this.style];
        const canvas = this._elements.mapCanvas;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const img = new Image();
        img.src = `https://www.sauce.llc/products/sauce4zwift/maps/world` +
            `${this.worldMeta.worldId}${suffix || ''}.webp`;
        try {
            await img.decode();
        } catch(e) {
            console.warn("Image decode interrupted/failed", e);
            return;
        }
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0);
        this._adjustLayerScale({force: true});
    }

    incPause() {
        this._pauseRefCnt++;
        if (this._pauseRefCnt === 1) {
            this._mapTransition.incDisabled();
        }
    }

    decPause() {
        this._pauseRefCnt--;
        if (this._pauseRefCnt < 0) {
            throw new Error("decPause < 0");
        } else if (this._pauseRefCnt === 0) {
            try {
                this._updateGlobalTransform({render: true});
            } finally {
                this._mapTransition.decDisabled();
            }
        }
    }

    isPaused() {
        return this._pauseRefCnt > 0;
    }

    async setCourse(courseId) {
        if (courseId === this.courseId) {
            console.warn("debounce setCourse");
            return;
        }
        this.incPause();
        try {
            await this._setCourse(courseId);
        } finally {
            this.decPause();
        }
    }

    async _setCourse(courseId) {
        this.courseId = courseId;
        const m = this.worldMeta = this.worldList.find(x => x.courseId === courseId);
        this._mapScale = 1 / (m.tileScale / m.mapScale);
        this._anchorXY[0] = -(m.minX + m.anchorX) * this._mapScale;
        this._anchorXY[1] = -(m.minY + m.anchorY) * this._mapScale;
        Object.values(this._elements.roadLayers).forEach(x => x.replaceChildren());
        this._elements.roads.setAttribute('viewBox', [
            (m.minX + m.anchorX) * svgInternalScale,
            (m.minY + m.anchorY) * svgInternalScale,
            (m.maxX - m.minX) * svgInternalScale,
            (m.maxY - m.minY) * svgInternalScale,
        ].join(' '));
        this._setHeading(0);
        for (const x of this._ents.values()) {
            x.el.remove();
        }
        this._ents.clear();
        this._athleteCache.clear();
        const [roads] = await Promise.all([
            common.getRoads(this.worldMeta.worldId),
            this._updateMapBackground(),
        ]);
        this._renderRoads(roads);
    }

    setWatching(id) {
        if (this.watchingId != null && this._ents.has(this.watchingId)) {
            const ent = this._ents.get(this.watchingId);
            ent.el.classList.remove('watching');
        }
        this.watchingId = id;
        if (id != null && this._ents.has(id)) {
            const ent = this._ents.get(id);
            ent.el.classList.add('watching');
        }
        this.setDragOffset(0, 0);
    }

    setAthlete(id) {
        if (this.athleteId != null && this._ents.has(this.athleteId)) {
            const ent = this._ents.get(this.athleteId);
            ent.el.classList.remove('self');
        }
        this.athleteId = id;
        if (id != null && this._ents.has(id)) {
            const ent = this._ents.get(id);
            ent.el.classList.add('self');
        }
    }

    _fixWorldPos(pos) {
        // Maybe zomday I'll know why...
        return this.worldMeta.mapRotateHack ? [pos[1], -pos[0]] : pos;
    }

    _createRoadPath(points, id, loop) {
        const d = [];
        for (const pos of points) {
            const [x, y] = this._fixWorldPos(pos);
            d.push([x * svgInternalScale, y * svgInternalScale]);
        }
        return createElementSVG('path', {
            id: `road-path-${id}`,
            d: smoothPath(d, {loop})
        });
    }

    _renderRoads(roads, ids) {
        ids = ids || Object.keys(roads);
        const {defs, surfacesLow, gutters} = this._elements.roadLayers;
        // Because roads overlap and we want to style some of them differently this
        // make multi-sport roads higher so we don't randomly style overlapping sections.
        ids.sort((a, b) =>
            (roads[a] ? roads[a].sports.length : 0) -
            (roads[b] ? roads[b].sports.length : 0));
        for (const id of ids) {
            const road = roads[id];
            if (!road) {
                console.error("Road not found:", id);
                continue;
            }
            if (!road.sports.includes('cycling') && !road.sports.includes('running')) {
                continue;
            }
            const path = this._createRoadPath(road.path, id, road.looped);
            const clip = createElementSVG('clipPath', {id: `road-clip-${id}`});
            let boxMin = this._fixWorldPos(road.boxMin);
            let boxMax = this._fixWorldPos(road.boxMax);
            if (this.worldMeta.mapRotateHack) {
                [boxMin, boxMax] = [boxMax, boxMin];
            }
            const clipBox = createElementSVG('path', {
                d: [
                    `M ${boxMin[0] * svgInternalScale} ${boxMin[1] * svgInternalScale}`,
                    `H ${boxMax[0] * svgInternalScale}`,
                    `V ${boxMax[1] * svgInternalScale}`,
                    `H ${boxMin[0] * svgInternalScale}`,
                    `Z`
                ].join('')
            });
            clip.append(clipBox);
            defs.append(path, clip);
            for (const g of [gutters, surfacesLow]) {
                g.append(createElementSVG('use', {
                    "class": road.sports.map(x => 'road sport-' + x).join(' '),
                    "data-id": id,
                    "clip-path": `url(#road-clip-${id})`,
                    "href": `#road-path-${id}`,
                }));
            }
        }
        if (this.roadId != null) {
            this.setActiveRoad(this.roadId);
        }
    }

    latlngToPosition([lat, lon]) {
        return this.worldMeta.flippedHack ? [
            (lat - this.worldMeta.latOffset) * this.worldMeta.latDegDist * 100,
            (lon - this.worldMeta.lonOffset) * this.worldMeta.lonDegDist * 100
        ] : [
            -(lon - this.worldMeta.latOffset) * this.worldMeta.latDegDist * 100,
            (lat - this.worldMeta.lonOffset) * this.worldMeta.lonDegDist * 100
        ];
    }

    setRoad(id) {
        console.warn("DEPRECATED: use setActiveRoad");
        return this.setActiveRoad(id);
    }

    setActiveRoad(id) {
        this.roadId = id;
        const surface = this._elements.roadLayers.surfacesMid;
        let r = surface.querySelector('.road.active');
        if (!r) {
            r = createElementSVG('use', {class: 'road active'});
            surface.append(r);
        }
        r.setAttribute('clip-path', `url(#road-clip-${id})`);
        r.setAttribute('href', `#road-path-${id}`);
    }

    addHighlightPath(points, id, loop) {
        this._elements.roadLayers.defs.append(this._createRoadPath(points, id, loop));
        this._elements.roadLayers.surfacesHigh.append(createElementSVG('use', {
            "class": `highlight`,
            "data-id": id,
            "href": `#road-path-${id}`,
        }));
    }

    _addAthleteEntity(state) {
        const el = document.createElement('div');
        el.classList.add('entity', 'athlete');
        el.classList.toggle('self', state.athleteId === this.athleteId);
        el.classList.toggle('watching', state.athleteId === this.watchingId);
        el.dataset.athleteId = state.athleteId;
        this._ents.set(state.athleteId, {
            el,
            new: true,
            athleteId: state.athleteId,
            lastSeen: 0,
            transition: new Transition({duration: 2000}),
            delayEst: common.expWeightedAvg(6, 1000),
        });
    }

    _onEntsClick(ev) {
        const entEl = ev.target.closest('.entity');
        if (!entEl) {
            return;
        }
        const ent = this._ents.get(Number(entEl.dataset.athleteId));
        if (!ent) {
            return;
        }
        if (!ent.pin) {
            const pin = document.createElement('div');
            pin.setAttribute('tabindex', 0); // Support click to focus so it can stay higher
            pin.classList.add('pin-anchor');
            const pinInner = document.createElement('div');
            pinInner.classList.add('pin-inner');
            pin.append(pinInner);
            const pinContent = document.createElement('div');
            pinContent.classList.add('pin-content');
            pinInner.append(pinContent);
            ent.pin = pin;
            this._elements.pins.append(pin);
            this._pinned.add(ent);
        } else {
            this._pinned.delete(ent);
            ent.pin.remove();
            ent.pin = null;
        }
    }

    renderAthleteStates(states) {
        if (this.watchingId == null) {
            return;
        }
        const watching = states.find(x => x.athleteId === this.watchingId);
        if (!watching && this.courseId == null) {
            return;
        } else if (watching) {
            if (watching.courseId !== this.courseId) {
                console.debug("Setting new course:", watching.courseId);
                this.setCourse(watching.courseId);
            }
            if (watching.roadId !== this.roadId) {
                this.setActiveRoad(watching.roadId);
            }
        }
        const now = Date.now();
        for (const state of states) {
            if (!this._ents.has(state.athleteId)) {
                this._addAthleteEntity(state);
            }
            let powerLevel;
            if (state.power < 200) {
                powerLevel = 'z1';
            } else if (state.power < 250) {
                powerLevel = 'z2';
            } else if (state.power < 300) {
                powerLevel = 'z3';
            } else if (state.power < 450) {
                powerLevel = 'z4';
            } else if (state.power < 600) {
                powerLevel = 'z5';
            } else {
                powerLevel = 'z6';
            }
            const ent = this._ents.get(state.athleteId);
            const age = now - ent.lastSeen;
            if (age) {
                if (age < 2500) {
                    // Try to animate close to the update rate without going under.
                    // If we miss (transition is not playing) prefer lag over jank.
                    // Note the lag is calibrated to reducing jumping at 200ms rates (i.e. watching).
                    const influence = ent.transition.playing ? age + 100 : age * 8;
                    const duration = ent.delayEst(influence);
                    ent.transition.setDuration(duration);
                } else {
                    ent.transition.setDuration(0);
                }
            }
            const pos = this._fixWorldPos([state.x, state.y]);
            ent.transition.setValues(pos);
            ent.el.dataset.powerLevel = powerLevel;
            ent.lastSeen = now;
            if (ent.pin) {
                const ad = this._athleteCache.get(state.athleteId);
                const name = ad && ad.data && ad.data.athlete ?
                    `${ad.data.athlete.fLast}` : `ID: ${state.athleteId}`;
                common.softInnerHTML(ent.pin.querySelector('.pin-content'), `
                    <a href="/pages/profile.html?id=${state.athleteId}&width=800&height=320"
                       target="profile">${common.sanitize(name)}</a><br/>
                    Power: ${H.power(state.power, {suffix: true, html: true})}<br/>
                    Speed: ${H.pace(state.speed, {suffix: true, html: true})}
                `);
            }
            if (state.athleteId === this.watchingId && !this.trackingPaused) {
                if (this.autoHeading) {
                    this._setHeading(state.heading);
                }
                this._centerXY[0] = pos[0] * this._mapScale;
                this._centerXY[1] = pos[1] * this._mapScale;
                this._updateGlobalTransform();
            }
            this._pendingEntityUpdates.add(ent);
        }
        idle().then(() => this._lazyUpdateAthleteDetails(states.map(x => x.athleteId)));
    }

    async _gcLoop() {
        await idle({timeout: 1000});
        setTimeout(() => this._gcLoop(), 10000);
        const now = Date.now();
        for (const [athleteId, ent] of this._ents.entries()) {
            if (now - ent.lastSeen > 15000) {
                ent.el.remove();
                if (ent.pin) {
                    ent.pin.remove();
                }
                this._pinned.delete(ent);
                this._pendingEntityUpdates.delete(ent);
                this._ents.delete(athleteId);
            }
        }
    }

    _updatePins() {
        const transforms = [];
        // XXX this batching may not work actually, plus we may not care given how few pins there will be
        //
        // Avoid spurious reflow with batched reads followed by writes.
        for (const ent of this._pinned) {
            const rect = ent.el.getBoundingClientRect();
            transforms.push([ent.pin, rect]);
        }
        for (const [pin, rect] of transforms) {
            pin.style.setProperty('transform', `translate(${rect.x + rect.width / 2}px, ${rect.y}px)`);
        }
    }

    _adjustLayerScale({force}={}) {
        // This is a solution for 3 problems:
        //  1. Blink will convert compositing layers to bitmaps using suboptimal
        //     resolutions during transitions, which we are always doing.  This
        //     makes all scaled elements look fuzzy and very low resolution.
        //  2. The GPU memory budget can explode when zooming out on large worlds
        //     like Watopia.  Mobile devices only have about 256MB (maybe less) of
        //     GPU memory to work with.  On Watopia, fully zoomed out, with the layer
        //     size being 8192x4096 will use about 1GB of memory if unscaled.  This
        //     causes the render pipeline to fail spectacularly and the page is broken.
        //  3. Performance because of #2 is pretty bad for large worlds when zoomed
        //     out.
        //  The technique here is quite simple, we just examine the zoom level and
        //  essentially swap out the layer with a different size.  Currently we just
        //  use the same assets.  The SVG scales of course, and the img is only ever
        //  scaled down (mostly).  It introduces some jank, so we chunk this operation
        //  to only perform as needed to stay within GPU constraints.
        const chunk = 0.5; // How frequently we jank.
        const adjZoom = Math.min(
            this.zoomMax,
            Math.max(this.zoomMin, Math.round(1 / this.zoom / chunk) * chunk));
        let quality = this.quality;
        if (this._tiltShift) {
            // When zoomed in tiltShift can exploded the GPU budget if a lot of
            // landscape is visible.  We need an additional scale factor to prevent
            // users from having to constantly adjust quality.
            const tiltFactor = this._zoomPrioTilt ? Math.min(1, (1 / this.zoomMax * (this.zoom + 1))) : 1;
            this._tiltShiftAngle = this._tiltShift * this.maxTiltShiftAngle * tiltFactor;
            quality *= Math.min(1, 15 / Math.max(0, this._tiltShiftAngle - 30));
        } else {
            this._tiltShiftAngle = 0;
        }
        const scale = 1 / adjZoom * quality;
        this._tiltHeight = this._tiltShift ? 800 / (this.zoom / scale) : 0;
        if (force || this._layerScale !== scale) {
            this.incPause();
            this._layerScale = scale;
            const {mapCanvas, ents, map} = this._elements;
            mapCanvas.style.setProperty('width', `${mapCanvas.width * scale}px`);
            mapCanvas.style.setProperty('height', `${mapCanvas.height * scale}px`);
            ents.style.setProperty('left', `${this._anchorXY[0] * scale}px`);
            ents.style.setProperty('top', `${this._anchorXY[1] * scale}px`);
            map.style.setProperty('--layer-scale', scale);
            for (const x of this._ents.values()) {
                // force refresh of _all_ ents.
                this._pendingEntityUpdates.add(x);
            }
            this.decPause();
            return true;
        }
        return false;
    }

    _updateGlobalTransform(options={}) {
        if (this._layerScale == null) {
            return;
        }
        const scale = this.zoom / this._layerScale;
        const relX = this._anchorXY[0] + this._centerXY[0];
        const relY = this._anchorXY[1] + this._centerXY[1];
        const dragX = this._dragXY[0] * scale;
        const dragY = this._dragXY[1] * scale;
        const tX = -(relX - dragX) * this._layerScale;
        const tY = -(relY - dragY) * this._layerScale;
        const originX = relX * this._layerScale;
        const originY = relY * this._layerScale;
        let vertOffset = 0;
        if (this.verticalOffset) {
            const height = this._elHeight * this._layerScale / this.zoom;
            vertOffset = this.verticalOffset * height;
        }
        this._mapTransition.setValues([
            originX, originY,
            tX, tY,
            scale,
            this._tiltHeight, this._tiltShiftAngle,
            vertOffset,
            this.adjHeading,
        ]);
        if (options.render) {
            this._renderFrame();
        }
    }

    _transformAnimationLoop(frameTime) {
        requestAnimationFrame(this._transformAnimationLoopBound);
        if (frameTime - this._lastFrameTime < this._msPerFrame) {
            return;
        }
        this._lastFrameTime = frameTime;
        this._renderFrame();
    }

    _renderFrame() {
        const transform = this._mapTransition.getStep();
        if (transform) {
            const [oX, oY, tX, tY, scale, tiltHeight, tiltAngle, vertOffset, rotate] = transform;
            this._elements.map.style.setProperty('transform-origin', `${oX}px ${oY}px`);
            this._elements.map.style.setProperty('transform', `
                translate(${tX}px, ${tY}px)
                scale(${scale})
                ${tiltHeight ? `perspective(${tiltHeight}px) rotateX(${tiltAngle}deg)` : ''}
                ${vertOffset ? `translate(0, ${vertOffset}px)` : ''}
                rotate(${rotate}deg)
            `);
        }
        const scale = this._mapScale * this._layerScale;
        for (const ent of this._pendingEntityUpdates) {
            const pos = ent.transition.getStep();
            if (pos) {
                ent.el.style.setProperty('transform', `translate(${pos[0] * scale}px, ${pos[1] * scale}px)`);
            }
            if (ent.new) {
                this._elements.ents.append(ent.el);
                ent.new = false;
            }
            if (!ent.transition.playing) {
                this._pendingEntityUpdates.delete(ent);
            }
        }
        this._updatePins();
    }

    _updateEntityAthleteData(ent, ad) {
        const leader = !!ad.eventLeader;
        const sweeper = !!ad.eventSweeper;
        const marked = !!ad.athlete?.marked;
        const following = !!ad.athlete?.following;
        const bot = ad.athlete?.type === 'PACER_BOT';
        if (bot !== ent.bot) {
            ent.el.classList.toggle('bot', bot);
            ent.bot = bot;
        }
        if (leader !== ent.leader) {
            ent.el.classList.toggle('leader', leader);
            ent.leader = leader;
        }
        if (sweeper !== ent.sweeper) {
            ent.el.classList.toggle('sweeper', sweeper);
            ent.sweeper = sweeper;
        }
        if (marked !== ent.marked) {
            ent.el.classList.toggle('marked', marked);
            ent.marked = marked;
        }
        if (following !== ent.following) {
            ent.el.classList.toggle('following', following);
            ent.following = following;
        }
    }

    _lazyUpdateAthleteDetails(ids) {
        const now = Date.now();
        const refresh = [];
        for (const id of ids) {
            const ent = this._ents.get(id);
            if (!ent) {
                continue;
            }
            const entry = this._athleteCache.get(id) || {ts: 0, data: null};
            if (now - entry.ts > 30000 + Math.random() * 60000) {
                entry.ts = now;
                this._athleteCache.set(id, entry);
                refresh.push(id);
            } else if (entry.data) {
                this._updateEntityAthleteData(ent, entry.data);
            }
        }
        if (refresh.length && isVisible()) {
            common.rpc.getAthletesData(refresh).then(ads => {
                for (const ad of ads) {
                    const ent = this._ents.get(ad.athleteId);
                    if (ent) {
                        this._updateEntityAthleteData(ent, ad);
                    }
                    const ac = this._athleteCache.get(ad.athleteId);
                    if (ac) {
                        ac.data = ad;
                    }
                }
            });
        }
        for (const [id, entry] of this._athleteCache.entries()) {
            if (now - entry.ts > 300000) {
                this._athleteCache.delete(id);
            }
        }
    }

    setHeadingOffset(deg) {
        this._headingOfft = deg || 0;
        this._setHeading(this._lastHeading, true);
        this._updateGlobalTransform({render: true});
    }

    _setHeading(heading, force) {
        if (!force && this.trackingPaused) {
            return false;
        }
        if (Math.abs(this._lastHeading - heading) > 180) {
            this._headingRotations += Math.sign(this._lastHeading - heading);
        }
        const mapAdj = this.worldMeta ? (this.worldMeta.rotateRouteSelect ? 0 : -90) : 0;
        this.adjHeading = heading + this._headingRotations * 360 + this._headingOfft + mapAdj;
        this._lastHeading = heading;
        return true;
    }
}
