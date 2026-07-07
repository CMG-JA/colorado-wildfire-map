(() => {
    // ============================================================
    // COLORADO-SPECIFIC CONFIGURATION
    // ============================================================
    // Colorado bounding box: SW corner to NE corner (with padding for context)
    const STATE_BOUNDS = [
        [-109.5, 36.8],  // Southwest: Four Corners area
        [-101.8, 41.2]   // Northeast: Nebraska border
    ];
    // Expanded bounds to prevent panning too far outside the state
    const MAX_BOUNDS = [
        [-112.0, 34.0],  // Southwest limit
        [-99.0, 44.0]    // Northeast limit
    ];
    const STATE_CENTER = [-105.5, 39.0];  // Roughly Denver area
    // ============================================================

    const MAPBOX_TOKEN = window.MAPBOX_ACCESS_TOKEN || document.body.dataset.mapboxToken || '';
    const TOP_FIRE_LIMIT = Number(document.body.dataset.topFires || 5);
    const COLORADO_QUERY_ENVELOPE = '-109.060253,36.992426,-102.041524,41.003444';
    const PERIMETERS_ENDPOINT = buildArcgisSpatialQueryUrl(
        'WFIGS_Interagency_Perimeters_Current'
    );
    const INCIDENTS_ENDPOINT = buildArcgisSpatialQueryUrl(
        'WFIGS_Incident_Locations_Current'
    );
    const DAY_MS = 86_400_000;
    const SIZE_BUCKETS = [
        { id: 'mega', label: 'Mega - 100k+ acres', min: 100_000, max: null, color: '#ff4d4f' },
        { id: 'major', label: 'Major - 50k-100k', min: 50_000, max: 100_000, color: '#ff7648' },
        { id: 'large', label: 'Large - 10k-50k', min: 10_000, max: 50_000, color: '#ffa347' },
        { id: 'medium', label: 'Medium - 1k-10k', min: 1_000, max: 10_000, color: '#ffd257' },
        { id: 'small', label: 'Small - under 1k', min: 0, max: 1_000, color: '#fef2a1' }
    ];
    const BUCKET_MAP = new Map(SIZE_BUCKETS.map((bucket) => [bucket.id, bucket]));
    const SMALL_FIRE_ACRES = 3_000;
    const MAPBOX_STYLES = {
        terrain: 'mapbox://styles/evnwlg/cmilw81c000ii01r9b7lm9py5',
        satellite: 'mapbox://styles/mapbox/satellite-streets-v12'
    };
    const AQ_SOURCE_ID = 'aq-tiles';
    const AQ_LAYER_ID = 'aq-tiles-layer';
    const AQ_TILE_URL = 'https://tiles.aqicn.org/tiles/usepa-aqi/{z}/{x}/{y}.png?token=demo';
    const RFW_SOURCE_ID = 'red-flag-warnings';
    const RFW_FILL_LAYER_ID = 'red-flag-warnings-fill';
    const RFW_LINE_LAYER_ID = 'red-flag-warnings-line';
    // NWS active alerts API returns GeoJSON directly, scoped to Colorado issuances.
    const RFW_ALERTS_ENDPOINT = 'https://api.weather.gov/alerts/active?event=Red%20Flag%20Warning&area=CO';
    // Standard NWS product color for Red Flag Warning.
    const RFW_COLOR = '#ff1493';
    const COUNTY_SOURCES_ENDPOINT = 'data/county-evacuation-sources.json';
    const MAPBOX_GEOCODE_ENDPOINT = 'https://api.mapbox.com/geocoding/v5/mapbox.places/';
    const COLORADO_GEOCODE_BBOX = '-109.060253,36.992426,-102.041524,41.003444';
    const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };
    const SELECTED_PLACE_SOURCE_ID = 'selected-place';
    const SELECTED_PLACE_LAYER_ID = 'selected-place-marker';

    const refs = {
        loading: document.getElementById('loading-overlay'),
        errorBanner: document.getElementById('error-banner'),
        lastUpdate: document.getElementById('last-update'),
        metricFires: document.getElementById('metric-fires'),
        metricAcres: document.getElementById('metric-acres'),
        metricContainment: document.getElementById('metric-containment'),
        topFiresList: document.getElementById('top-fires-list'),
        sizeFilterContainer: document.getElementById('size-filter-container'),
        containmentFilter: document.getElementById('containment-filter'),
        airQualityToggle: document.getElementById('aq-toggle'),
        redFlagToggle: document.getElementById('rfw-toggle'),
        timelineRange: document.getElementById('timeline-range'),
        timelineLabel: document.getElementById('timeline-label'),
        styleButtons: document.querySelectorAll('.style-toggle button'),
        placeSearchForm: document.getElementById('place-search-form'),
        placeSearchInput: document.getElementById('place-search-input'),
        placeSearchResults: document.getElementById('place-search-results'),
        useLocation: document.getElementById('use-location'),
        selectedPlace: document.getElementById('selected-place'),
        selectedPlaceSummary: document.getElementById('selected-place-summary'),
        selectedPlaceLinks: document.getElementById('selected-place-links'),
        clearPlace: document.getElementById('clear-place'),
        nearestFires: document.getElementById('nearest-fires'),
        nearestFiresList: document.getElementById('nearest-fires-list'),
        sourceStatus: document.getElementById('source-status'),
        copyLink: document.getElementById('copy-link'),
        copyStatus: document.getElementById('copy-status')
    };

    const state = {
        geojson: null,
        activeSizeBuckets: new Set(SIZE_BUCKETS.map((bucket) => bucket.id)),
        containmentFilter: 'all',
        timeline: { enabled: false, minTs: null, maxTs: null, currentTs: null },
        showAirQuality: false,
        showRedFlagWarnings: true,
        redFlagGeojson: null,
        redFlagFetchPromise: null,
        baseStyle: 'terrain',
        featureLookupByName: new Map(),
        featureLookupById: new Map(),
        selectedPlace: null,
        selectedFireId: null,
        initialMapView: null,
        initialTimelineTs: null,
        countySources: {},
        restoredFireKey: null,
        mapPadding: { top: 24, bottom: 24, left: 24, right: 320 },
        sourceStatus: {
            fires: { status: 'loading', fetchedAt: null, sourceUpdatedAt: null, error: null },
            incidents: { status: 'loading', fetchedAt: null, sourceUpdatedAt: null, error: null },
            redFlag: { status: 'loading', fetchedAt: null, sourceUpdatedAt: null, error: null },
            aqi: { status: 'available', fetchedAt: null, sourceUpdatedAt: null, error: null },
            county: { status: 'loading', fetchedAt: null, sourceUpdatedAt: null, error: null }
        }
    };
    const initialUrlState = readUrlState();
    applyInitialUrlState(initialUrlState);

    if (!MAPBOX_TOKEN) {
        blockInitialization('Add a Mapbox access token by setting window.MAPBOX_ACCESS_TOKEN before loading this page.');
        return;
    }

    mapboxgl.accessToken = MAPBOX_TOKEN;
    // Below 980px the map is laid out in-flow (not fixed full-screen), so it
    // sits inline with page content the user needs to scroll past. Cooperative
    // gestures let a single-finger swipe scroll the page instead of panning
    // the map; two fingers (or ctrl/cmd + scroll) are required to move the map.
    const isScrollableLayout = window.matchMedia('(max-width: 980px)').matches;

    const map = new mapboxgl.Map({
        container: 'map',
        style: MAPBOX_STYLES[state.baseStyle],
        bounds: STATE_BOUNDS,
        fitBoundsOptions: { padding: 20 },
        maxBounds: MAX_BOUNDS,
        minZoom: 5,
        attributionControl: false,
        cooperativeGestures: isScrollableLayout
    });

    map.addControl(new mapboxgl.AttributionControl({ customAttribution: 'Fire data: NIFC/WFIGS. Weather: National Weather Service.' }));
    map.addControl(new mapboxgl.NavigationControl(), 'top-left');
    map.addControl(new mapboxgl.FullscreenControl(), 'top-left');

    const clickPopup = new mapboxgl.Popup({ closeButton: true, anchor: 'top', maxWidth: '320px' });
    let interactionsBound = false;
    let redFlagInteractionsBound = false;
    let placeSearchTimer = null;
    let placeSearchRequestId = 0;

    initializeStyleToggle();
    initializeSizeFilters();
    initializeContainmentFilter();
    initializeAirQualityToggle();
    initializeRedFlagToggle();
    initializeAccordionHints();
    initializePlaceSearch();
    initializeShareControls();
    applyInitialControlState(initialUrlState);
    renderSourceStatus();
    const countySourcesPromise = loadCountySources();

    map.on('load', async () => {
        try {
            const geojson = await fetchAndMergeWildfireData();
            enrichFeatureProperties(geojson);
            state.geojson = geojson;
            rebuildFeatureLookup();
            initWildfireLayers();
            ensureSelectedPlaceLayer();
            updateStatsPanel();
            initializeTimelineControls();
            applyMapPadding();
            await countySourcesPromise;
            restoreUrlStateAfterData(initialUrlState);
            refs.lastUpdate.textContent = `Data loaded: ${formatDateTime(state.sourceStatus.fires.fetchedAt || Date.now())}`;
            refs.lastUpdate.hidden = false;
            refs.errorBanner.hidden = true;
        } catch (error) {
            console.error('Error loading wildfire data:', error);
            showError(`Unable to load wildfire data: ${error.message}`);
            renderSourceStatus();
        } finally {
            refs.loading.classList.add('is-hidden');
        }
    });

    map.on('load', async () => {
        if (!state.showRedFlagWarnings) return;
        try {
            await ensureRedFlagWarningsLayer();
        } catch (error) {
            console.error('Error loading red flag warnings:', error);
        }
    });

    map.on('style.load', () => {
        if (state.geojson) {
            initWildfireLayers();
        }
        if (state.showAirQuality) {
            ensureAirQualityLayer();
        }
        if (state.showRedFlagWarnings) {
            ensureRedFlagWarningsLayer();
        }
        ensureSelectedPlaceLayer();
        applyMapPadding();
    });

    window.addEventListener('resize', () => {
        applyMapPadding();
    });

    function initializeStyleToggle() {
        syncStyleButtons();
        refs.styleButtons.forEach((button) => {
            button.addEventListener('click', () => {
                const targetStyle = button.dataset.style;
                if (!targetStyle || state.baseStyle === targetStyle) return;
                state.baseStyle = targetStyle;
                syncStyleButtons();
                map.setStyle(MAPBOX_STYLES[targetStyle]);
                updateUrlState();
            });
        });
    }

    function syncStyleButtons() {
        refs.styleButtons.forEach((button) => {
            const isActive = button.dataset.style === state.baseStyle;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', String(isActive));
        });
    }

    function initializeSizeFilters() {
        SIZE_BUCKETS.forEach((bucket) => {
            const label = document.createElement('label');
            label.className = 'chip';

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = bucket.id;
            input.checked = state.activeSizeBuckets.has(bucket.id);

            const content = document.createElement('span');
            content.className = 'chip-content';

            const swatch = document.createElement('span');
            swatch.className = 'chip-swatch';
            swatch.style.background = bucket.color;

            const text = document.createElement('span');
            text.textContent = bucket.label;

            content.append(swatch, text);
            label.append(input, content);
            refs.sizeFilterContainer.append(label);

            input.addEventListener('change', () => {
                if (input.checked) {
                    state.activeSizeBuckets.add(bucket.id);
                } else {
                    state.activeSizeBuckets.delete(bucket.id);
                }
                updateMapFilters();
                updateUrlState();
            });
        });
    }

    function initializeContainmentFilter() {
        refs.containmentFilter.addEventListener('change', (event) => {
            state.containmentFilter = event.target.value;
            updateMapFilters();
            updateUrlState();
        });
    }

    function initializeAirQualityToggle() {
        refs.airQualityToggle.addEventListener('change', (event) => {
            state.showAirQuality = event.target.checked;
            if (state.showAirQuality) {
                ensureAirQualityLayer();
            } else if (map.getLayer(AQ_LAYER_ID)) {
                map.setLayoutProperty(AQ_LAYER_ID, 'visibility', 'none');
            }
            updateUrlState();
        });
    }

    function initializeRedFlagToggle() {
        if (!refs.redFlagToggle) return;
        refs.redFlagToggle.addEventListener('change', async (event) => {
            state.showRedFlagWarnings = event.target.checked;
            if (state.showRedFlagWarnings) {
                refs.redFlagToggle.disabled = true;
                if (state.sourceStatus.redFlag.status === 'disabled') {
                    state.sourceStatus.redFlag = { status: 'loading', fetchedAt: null, sourceUpdatedAt: null, error: null };
                    renderSourceStatus();
                }
                try {
                    await ensureRedFlagWarningsLayer();
                } catch (error) {
                    console.error('Error loading red flag warnings:', error);
                    showError('Unable to load red flag warning data.');
                    state.showRedFlagWarnings = false;
                    refs.redFlagToggle.checked = false;
                } finally {
                    refs.redFlagToggle.disabled = false;
                }
            } else {
                state.sourceStatus.redFlag = { status: 'disabled', fetchedAt: null, sourceUpdatedAt: null, error: null };
                hideRedFlagWarningsLayer();
                renderSourceStatus();
            }
            updateUrlState();
        });
    }

    function initializeAccordionHints() {
        document.querySelectorAll('.accordion').forEach((accordion) => {
            const hint = accordion.querySelector('.accordion-hint');
            if (!hint) return;
            const sync = () => {
                hint.textContent = accordion.open ? 'Hide' : 'Show';
            };
            sync();
            accordion.addEventListener('toggle', sync);
        });
    }

    function buildArcgisSpatialQueryUrl(serviceName) {
        // Fetch incidents/perimeters that spatially intersect Colorado bounds.
        // This includes fires whose origin state is outside Colorado but whose
        // footprint overlaps Colorado.
        const base = `https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/${serviceName}/FeatureServer/0/query`;
        const params = new URLSearchParams({
            where: '1=1',
            outFields: '*',
            f: 'geojson',
            geometry: COLORADO_QUERY_ENVELOPE,
            geometryType: 'esriGeometryEnvelope',
            inSR: '4326',
            spatialRel: 'esriSpatialRelIntersects'
        });
        return `${base}?${params.toString()}`;
    }

    async function fetchAndMergeWildfireData() {
        const [perimeterResult, incidentResult] = await Promise.allSettled([
            fetchGeoJsonCollection(PERIMETERS_ENDPOINT, 'fires'),
            fetchGeoJsonCollection(INCIDENTS_ENDPOINT, 'incidents')
        ]);

        if (perimeterResult.status === 'rejected') {
            state.sourceStatus.fires = {
                status: 'error',
                fetchedAt: Date.now(),
                sourceUpdatedAt: null,
                error: perimeterResult.reason?.message || 'Perimeter feed unavailable'
            };
            renderSourceStatus();
            throw new Error(`NIFC/WFIGS perimeters unavailable: ${state.sourceStatus.fires.error}`);
        }

        const perimeters = perimeterResult.value;
        const incidents = incidentResult.status === 'fulfilled'
            ? incidentResult.value
            : { ...EMPTY_COLLECTION, __error: incidentResult.reason?.message || 'Incident feed unavailable' };
        const perimeterFeatures = safeFeatures(perimeters);
        const incidentFeatures = safeFeatures(incidents);

        state.sourceStatus.fires = {
            status: perimeterFeatures.length ? 'loaded' : 'empty',
            fetchedAt: Date.now(),
            sourceUpdatedAt: maxTimestamp(perimeterFeatures.map((feature) => getFeatureUpdatedTimestamp(feature.properties || {}))),
            error: null
        };
        state.sourceStatus.incidents = {
            status: incidentResult.status === 'fulfilled'
                ? (incidentFeatures.length ? 'loaded' : 'empty')
                : 'error',
            fetchedAt: Date.now(),
            sourceUpdatedAt: maxTimestamp(incidentFeatures.map((feature) => getFeatureUpdatedTimestamp(feature.properties || {}))),
            error: incidentResult.status === 'fulfilled' ? null : (incidents.__error || 'Incident feed unavailable')
        };

        const perimeterIds = new Set(
            perimeterFeatures
                .map((feature) => getStableIncidentKey(feature.properties || {}))
                .filter(Boolean)
        );
        const perimeterNameCountyKeys = new Set(
            perimeterFeatures
                .map((feature) => getIncidentNameCountyKey(feature.properties || {}))
                .filter(Boolean)
        );

        // Mark all perimeter features as NOT points (use string for reliable filter matching)
        perimeterFeatures.forEach(f => {
            f.properties = f.properties || {};
            f.properties.__featureType = 'polygon';
        });

        const pointsWithoutPerimeters = incidentFeatures.filter(f => {
            const props = f.properties || {};
            const stableKey = getStableIncidentKey(props);
            if (stableKey) return !perimeterIds.has(stableKey);
            const nameCountyKey = getIncidentNameCountyKey(props);
            return nameCountyKey ? !perimeterNameCountyKeys.has(nameCountyKey) : true;
        });

        // Normalize incident point properties to match perimeter schema
        pointsWithoutPerimeters.forEach(f => {
            const props = f.properties || {};
            // Map incident fields to perimeter-style fields
            props.poly_IncidentName = props.IncidentName;
            props.poly_GISAcres = props.DailyAcres || props.CalculatedAcres || props.IncidentSize || 0;
            props.attr_PercentContained = props.PercentContained;
            props.attr_FireCause = props.FireCause;
            props.attr_POOState = props.POOState;
            props.attr_POOCounty = props.POOCounty;
            props.__featureType = 'point'; // Flag for rendering as point
            f.properties = props;
        });

        // Combine: perimeters first, then points without perimeters
        const combined = {
            type: 'FeatureCollection',
            features: [...perimeterFeatures, ...pointsWithoutPerimeters]
        };

        renderSourceStatus();
        return combined;
    }

    async function fetchGeoJsonCollection(url, label) {
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) {
            throw new Error(`${label}: ${response.status} ${response.statusText}`);
        }
        const json = await response.json();
        if (json?.error) {
            throw new Error(`${label}: ${json.error.message || 'source returned an error'}`);
        }
        return normalizeFeatureCollection(json);
    }

    function normalizeFeatureCollection(json) {
        return {
            type: 'FeatureCollection',
            features: Array.isArray(json?.features) ? json.features.filter(Boolean) : []
        };
    }

    function safeFeatures(collection) {
        return Array.isArray(collection?.features) ? collection.features.filter(Boolean) : [];
    }

    function getStableIncidentKey(props = {}) {
        const candidates = [
            props.poly_IRWINID,
            props.IRWINID,
            props.IrwinID,
            props.attr_IRWINID,
            props.UniqueFireIdentifier,
            props.LocalIncidentIdentifier
        ];
        const value = candidates.find((candidate) => candidate !== undefined && candidate !== null && String(candidate).trim());
        return value ? normalizeKey(value) : '';
    }

    function getIncidentNameCountyKey(props = {}) {
        const name = normalizeKey(props.poly_IncidentName || props.IncidentName || props.attr_IncidentName);
        const county = normalizeCountyName(props.attr_POOCounty || props.POOCounty || props.County);
        return name && county ? `${name}|${county.toLowerCase()}` : '';
    }

    function enrichFeatureProperties(geojson) {
        geojson.features = safeFeatures(geojson);
        geojson.features.forEach((feature, index) => {
            const props = feature.properties || {};
            const acres = Number.parseFloat(props.poly_GISAcres) || 0;
            const containment = Number.parseFloat(props.attr_PercentContained);
            props.__id = buildFeatureId(feature, index);
            props.__acres = acres;
            props.__containment = Number.isFinite(containment) ? containment : -1;
            props.__discoveryTs = parseTimestamp(props) ?? -1;
            props.__primaryName = props.poly_IncidentName || props.attr_IncidentName || 'Unnamed fire';
            props.__county = normalizeCountyName(props.attr_POOCounty || props.POOCounty || props.County);
            props.__updatedTs = getFeatureUpdatedTimestamp(props);
            props.__centroid = computeCentroid(feature.geometry);
            props.__bounds = computeBounds(feature.geometry);
            feature.properties = props;
        });
    }

    function rebuildFeatureLookup() {
        state.featureLookupByName.clear();
        state.featureLookupById.clear();
        state.geojson?.features.forEach((feature) => {
            const key = normalizeKey(feature.properties.__primaryName);
            if (key && !state.featureLookupByName.has(key)) {
                state.featureLookupByName.set(key, feature);
            }
            if (feature.properties.__id) {
                state.featureLookupById.set(feature.properties.__id, feature);
            }
        });
    }

    function buildFeatureId(feature, index) {
        const props = feature.properties || {};
        const stableKey = getStableIncidentKey(props);
        if (stableKey) return stableKey;

        const objectId = normalizeKey(props.OBJECTID);
        if (objectId) {
            return `${normalizeKey(props.__featureType || feature.geometry?.type || 'feature')}-${objectId}`;
        }

        const candidates = [
            props.poly_IRWINID,
            props.IRWINID,
            props.GlobalID,
            props.poly_IncidentName,
            props.IncidentName,
            index
        ];
        return candidates
            .filter((value) => value !== undefined && value !== null && String(value).trim())
            .map(normalizeKey)
            .join('-')
            .slice(0, 120);
    }

    function normalizeKey(value = '') {
        return String(value).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    }

    function getFeatureUpdatedTimestamp(props) {
        const candidateFields = [
            'attr_ModifiedOnDateTime_dt',
            'poly_DateCurrent',
            'attr_DateCurrent',
            'ModifiedOnDateTime',
            'DateCurrent',
            'attr_IrwinReportDate'
        ];
        for (const field of candidateFields) {
            const value = props[field];
            if (!value) continue;
            const ts = parseDateLike(value);
            if (Number.isFinite(ts)) return ts;
        }
        return null;
    }

    function parseTimestamp(props) {
        const candidateFields = [
            'attr_CreatedOnDateTime_dt',
            'attr_DateCurrent',
            'attr_ModifiedOnDateTime_dt',
            'attr_IrwinReportDate',
            'attr_FireDiscoveryDateTime'
        ];
        for (const field of candidateFields) {
            const value = props[field];
            if (!value) continue;
            const ts = parseDateLike(value);
            if (Number.isFinite(ts)) {
                return ts;
            }
        }
        return null;
    }

    function parseDateLike(value) {
        if (typeof value === 'number') return value;
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) return numeric;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function maxTimestamp(values) {
        const timestamps = values.filter((value) => Number.isFinite(value));
        return timestamps.length ? Math.max(...timestamps) : null;
    }

    function computeCentroid(geometry) {
        if (!geometry) return null;

        // Handle Point geometry directly
        if (geometry.type === 'Point') {
            const [lng, lat] = geometry.coordinates || [];
            return (lng !== undefined && lat !== undefined) ? { lng, lat } : null;
        }

        // Handle Polygon/MultiPolygon
        let coords = [];
        if (geometry.type === 'Polygon') {
            coords = geometry.coordinates?.[0] || [];
        } else if (geometry.type === 'MultiPolygon') {
            coords = geometry.coordinates?.[0]?.[0] || [];
        }
        if (!coords.length) return null;
        let sumLng = 0;
        let sumLat = 0;
        coords.forEach(([lng, lat]) => {
            sumLng += lng;
            sumLat += lat;
        });
        const count = coords.length;
        return count ? { lng: sumLng / count, lat: sumLat / count } : null;
    }

    function computeBounds(geometry) {
        if (!geometry) return null;
        let coords = [];
        if (geometry.type === 'Polygon') {
            coords = geometry.coordinates?.[0] || [];
        } else if (geometry.type === 'MultiPolygon') {
            geometry.coordinates?.forEach((poly) => {
                poly?.[0]?.forEach((c) => coords.push(c));
            });
        }
        if (!coords.length) return null;
        let minLng = Infinity;
        let maxLng = -Infinity;
        let minLat = Infinity;
        let maxLat = -Infinity;
        coords.forEach(([lng, lat]) => {
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        });
        if (!isFinite(minLng) || !isFinite(minLat) || !isFinite(maxLng) || !isFinite(maxLat)) {
            return null;
        }
        return [
            [minLng, minLat],
            [maxLng, maxLat]
        ];
    }

    function initWildfireLayers() {
        if (!state.geojson) return;
        const acresExpr = ['to-number', ['coalesce', ['get', '__acres'], 0]];
        // Filter for polygon features (perimeters) vs point features (incidents without perimeters)
        const isPolygon = ['any',
            ['==', ['geometry-type'], 'Polygon'],
            ['==', ['geometry-type'], 'MultiPolygon']
        ];
        const isPoint = ['==', ['geometry-type'], 'Point'];

        if (!map.getSource('wildfires')) {
            map.addSource('wildfires', { type: 'geojson', data: state.geojson });

            // === POLYGON LAYERS (fire perimeters) ===

            // 1. Symbol for small polygon fires (Zoom < 8)
            map.addLayer({
                id: 'wildfire-small-symbol',
                type: 'symbol',
                source: 'wildfires',
                filter: ['all', isPolygon, ['<', acresExpr, SMALL_FIRE_ACRES]],
                maxzoom: 8,
                layout: {
                    'text-field': 'x',
                    'text-font': ['Arial Unicode MS Bold'],
                    'text-size': 28,
                    'text-allow-overlap': true,
                    'text-ignore-placement': true
                },
                paint: {
                    'text-color': '#ff8c42',
                    'text-halo-color': '#b11226',
                    'text-halo-width': 2
                }
            });

            // 2. Fill for LARGE polygon fires (Always visible)
            map.addLayer({
                id: 'wildfire-fill-large',
                type: 'fill',
                source: 'wildfires',
                filter: ['all', isPolygon, ['>=', acresExpr, SMALL_FIRE_ACRES]],
                paint: {
                    'fill-color': '#ff8c42',
                    'fill-opacity': 0.6
                }
            }, 'wildfire-small-symbol');

            // 3. Fill for SMALL polygon fires (Zoom >= 8 only)
            map.addLayer({
                id: 'wildfire-fill-small',
                type: 'fill',
                source: 'wildfires',
                filter: ['all', isPolygon, ['<', acresExpr, SMALL_FIRE_ACRES]],
                minzoom: 8,
                paint: {
                    'fill-color': '#ff8c42',
                    'fill-opacity': 0.6
                }
            }, 'wildfire-small-symbol');

            // 4. Outline for LARGE polygon fires (Always visible)
            map.addLayer({
                id: 'wildfire-outline-large',
                type: 'line',
                source: 'wildfires',
                filter: ['all', isPolygon, ['>=', acresExpr, SMALL_FIRE_ACRES]],
                paint: {
                    'line-color': '#b11226',
                    'line-width': 1.5,
                    'line-opacity': 0.9
                }
            });

            // 5. Outline for SMALL polygon fires (Zoom >= 8 only)
            map.addLayer({
                id: 'wildfire-outline-small',
                type: 'line',
                source: 'wildfires',
                filter: ['all', isPolygon, ['<', acresExpr, SMALL_FIRE_ACRES]],
                minzoom: 8,
                paint: {
                    'line-color': '#b11226',
                    'line-width': 1.5,
                    'line-opacity': 0.9
                }
            });

            // === POINT LAYERS (incidents without perimeters) ===
            // Only show features with __featureType='point' (incident points without perimeters)
            const pointLayerFilter = ['==', ['get', '__featureType'], 'point'];

            // X symbol for point incidents (same style as small polygon fires)
            map.addLayer({
                id: 'wildfire-point-symbol',
                type: 'symbol',
                source: 'wildfires',
                filter: pointLayerFilter,
                layout: {
                    'text-field': 'x',
                    'text-font': ['Arial Unicode MS Bold'],
                    'text-size': 28,
                    'text-allow-overlap': true,
                    'text-ignore-placement': true
                },
                paint: {
                    'text-color': '#ff8c42',
                    'text-halo-color': '#b11226',
                    'text-halo-width': 2
                }
            });

        } else {
            map.getSource('wildfires').setData(state.geojson);
        }

        if (!interactionsBound) {
            bindMapInteractions();
            interactionsBound = true;
        }

        updateMapFilters();
    }

    function bindMapInteractions() {
        const clickableLayers = [
            'wildfire-small-symbol',
            'wildfire-fill-large',
            'wildfire-fill-small',
            'wildfire-point-symbol'
        ];

        map.on('click', (e) => {
            const features = map.queryRenderedFeatures(e.point, {
                layers: clickableLayers.filter(layer => map.getLayer(layer))
            });

            if (features.length > 0) {
                const feature = features[0];
                showFirePopup(feature, e.lngLat);
            }
        });

        // Cursor styling
        clickableLayers.forEach(layer => {
            map.on('mouseenter', layer, () => {
                map.getCanvas().style.cursor = 'pointer';
            });
            map.on('mouseleave', layer, () => {
                map.getCanvas().style.cursor = '';
            });
        });
    }

    function showFirePopup(feature, lngLat) {
        const resolvedFeature = resolveFeature(feature) || feature;
        const props = resolvedFeature.properties || feature.properties || {};
        state.selectedFireId = props.__id || null;
        updateUrlState();
        clickPopup
            .setLngLat(lngLat)
            .setHTML(buildPopupHtml(props, resolvedFeature))
            .addTo(map);
    }

    function buildPopupHtml(props, feature = null) {
        const acres = props.__acres ? `${formatNumber(Math.round(props.__acres))} acres` : 'Acreage unavailable';
        const containment = isKnownContainment(props.__containment) ? `${Math.round(props.__containment)}% contained` : 'Containment unknown';
        const cause = props.attr_FireCause || 'Unknown';
        const county = normalizeCountyName(props.__county || props.attr_POOCounty || props.POOCounty);
        const location = county ? `${county} County` : (props.attr_IncidentShortDescription ? props.attr_IncidentShortDescription : '');
        const isPointOnly = props.__featureType === 'point';
        const geometryStatus = isPointOnly ? 'Incident point only; perimeter unavailable.' : 'Current perimeter available.';
        const loadedAt = state.sourceStatus.fires.sourceUpdatedAt
            ? `Source timestamp: ${formatDateTime(state.sourceStatus.fires.sourceUpdatedAt)}`
            : `NIFC/WFIGS loaded ${formatTimeOnly(state.sourceStatus.fires.fetchedAt)}`;
        const distance = state.selectedPlace && feature
            ? distanceToFire(state.selectedPlace, feature)
            : null;

        return `
        <div class="popup">
            <h3>${escapeHtml(props.__primaryName || 'Unnamed fire')}</h3>
            <p class="popup-metric">${acres}</p>
            <p class="popup-meta">${containment}</p>
            <p class="popup-meta">Cause: ${escapeHtml(cause)}</p>
            ${location ? `<p class="popup-meta">${escapeHtml(location)}</p>` : ''}
            <p class="popup-meta">${escapeHtml(geometryStatus)}</p>
            ${distance ? `<p class="popup-meta">${escapeHtml(distance.label)}</p>` : ''}
            <p class="popup-source">Source: <a href="https://data-nifc.opendata.arcgis.com/" target="_blank" rel="noopener">NIFC/WFIGS</a>. ${escapeHtml(loadedAt)}</p>
            ${renderCountyLinksHtml(county)}
        </div>
        `;
    }

    function resolveFeature(feature) {
        const props = feature?.properties || {};
        if (props.__id && state.featureLookupById.has(props.__id)) {
            return state.featureLookupById.get(props.__id);
        }
        const key = normalizeKey(props.__primaryName);
        return key ? state.featureLookupByName.get(key) : null;
    }

    function updateStatsPanel() {
        const features = state.geojson?.features || [];
        const totalFires = features.length;
        const totalAcres = features.reduce((sum, feature) => sum + (feature.properties.__acres || 0), 0);
        const validContainments = features
            .map((feature) => feature.properties.__containment)
            .filter(isKnownContainment);
        const avgContainment = validContainments.length
            ? validContainments.reduce((a, b) => a + b, 0) / validContainments.length
            : null;

        refs.metricFires.textContent = totalFires ? formatNumber(totalFires) : '--';
        refs.metricAcres.textContent = totalAcres ? `${formatNumber(Math.round(totalAcres))}` : '--';
        refs.metricContainment.textContent = Number.isFinite(avgContainment)
            ? `${Math.round(avgContainment)}%`
            : '--';

        const sorted = [...features].sort((a, b) => (b.properties.__acres || 0) - (a.properties.__acres || 0));
        const top = sorted.slice(0, TOP_FIRE_LIMIT);
        refs.topFiresList.innerHTML = '';
        top.forEach((feature) => {
            const props = feature.properties;
            const li = document.createElement('li');
            const bucket = getBucketForAcres(props.__acres);
            li.className = 'fire-list-item';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'fire-list-button';
            if (props.__id) button.dataset.fireId = props.__id;
            button.innerHTML = `
                <strong>${escapeHtml(props.__primaryName || 'Unnamed fire')}</strong>
                <div class="fire-meta">${props.__acres ? `${formatNumber(Math.round(props.__acres))} acres` : 'Unknown size'} - ${
                isKnownContainment(props.__containment) ? `${Math.round(props.__containment)}% contained` : 'Containment unknown'
            }</div>
            `;
            if (bucket) {
                li.style.setProperty('--bullet-color', bucket.color);
                li.style.listStyle = 'none';
                li.style.position = 'relative';
                li.style.paddingLeft = '20px';
                const bullet = document.createElement('span');
                bullet.className = 'bullet';
                li.append(bullet);
            }
            li.append(button);
            refs.topFiresList.append(li);
        });
        attachTopFireHandlers();
    }

    function getBucketForAcres(acres = 0) {
        return SIZE_BUCKETS.find((bucket) => acres >= bucket.min && (bucket.max === null || acres < bucket.max)) || null;
    }

    function isKnownContainment(value) {
        return Number.isFinite(value) && value >= 0;
    }

    function attachTopFireHandlers() {
        refs.topFiresList.querySelectorAll('.fire-list-button[data-fire-id]').forEach((button) => {
            button.addEventListener('click', () => {
                const id = button.dataset.fireId;
                if (!id) return;
                const feature = state.featureLookupById.get(id);
                if (!feature) return;
                focusFeature(feature);
            });
        });
    }

    function focusFeature(feature, options = {}) {
        try {
            const bounds = feature.properties?.__bounds;
            const centroid = feature.properties?.__centroid;
            const padding = state.mapPadding || { top: 40, bottom: 40, left: 40, right: 40 };
            // Use provided lngLat (click point) or centroid
            const popupLocation = options.lngLat || (centroid ? [centroid.lng, centroid.lat] : null);
            state.selectedFireId = feature.properties?.__id || null;

            if (bounds) {
                map.fitBounds(bounds, {
                    padding: { ...padding, right: padding.right + 60 },
                    maxZoom: 11,
                    duration: 1000
                });
                map.once('moveend', updateUrlState);
            } else if (centroid) {
                map.flyTo({ center: [centroid.lng, centroid.lat], zoom: 8, essential: true });
                map.once('moveend', updateUrlState);
            }

            if (popupLocation) {
                clickPopup.setLngLat(popupLocation).setHTML(buildPopupHtml(feature.properties, feature)).addTo(map);
            }
            if (options.updateUrl !== false) updateUrlState();
        } catch (err) {
            console.error('Focus failed:', err);
        }
    }

    function initializeTimelineControls() {
        const timestamps = (state.geojson?.features || [])
            .map((feature) => feature.properties.__discoveryTs)
            .filter((ts) => Number.isFinite(ts) && ts >= 0);

        if (!timestamps.length) {
            refs.timelineRange.disabled = true;
            refs.timelineLabel.textContent = 'Timeline unavailable';
            state.timeline.enabled = false;
            return;
        }

        const minTs = Math.min(...timestamps);
        const maxTs = Math.max(...timestamps);
        const totalDays = Math.max(0, Math.round((maxTs - minTs) / DAY_MS));

        refs.timelineRange.min = 0;
        refs.timelineRange.max = totalDays || 1;
        refs.timelineRange.value = totalDays;
        state.timeline = { enabled: true, minTs, maxTs, currentTs: maxTs };
        updateTimelineLabel(maxTs);

        refs.timelineRange.addEventListener('input', () => {
            const offsetDays = Number(refs.timelineRange.value);
            const ts = state.timeline.minTs + offsetDays * DAY_MS;
            state.timeline.currentTs = ts;
            updateTimelineLabel(ts);
            updateMapFilters();
            updateUrlState();
        });
    }

    function updateTimelineLabel(ts) {
        refs.timelineLabel.textContent = new Date(ts).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
    }

    function ensureAirQualityLayer() {
        try {
            if (!map.getSource(AQ_SOURCE_ID)) {
                map.addSource(AQ_SOURCE_ID, {
                    type: 'raster',
                    tiles: [AQ_TILE_URL],
                    tileSize: 256,
                    attribution: 'Air quality overlay by AQICN, using EPA AQI tiles'
                });
            }
            if (!map.getLayer(AQ_LAYER_ID)) {
                const beforeId = map.getLayer('wildfire-fill-large') ? 'wildfire-fill-large' : undefined;
                map.addLayer(
                    {
                        id: AQ_LAYER_ID,
                        type: 'raster',
                        source: AQ_SOURCE_ID,
                        paint: { 'raster-opacity': 0.28 }
                    },
                    beforeId
                );
            } else {
                map.setLayoutProperty(AQ_LAYER_ID, 'visibility', 'visible');
            }
            state.sourceStatus.aqi = { status: 'available', fetchedAt: Date.now(), sourceUpdatedAt: null, error: null };
        } catch (error) {
            console.error('Unable to show AQI overlay:', error);
            state.sourceStatus.aqi = { status: 'error', fetchedAt: Date.now(), sourceUpdatedAt: null, error: error.message };
            refs.airQualityToggle.checked = false;
            state.showAirQuality = false;
        }
        renderSourceStatus();
    }

    async function ensureRedFlagWarningsLayer() {
        if (!state.redFlagGeojson) {
            if (!state.redFlagFetchPromise) {
                state.redFlagFetchPromise = fetchRedFlagWarnings();
            }
            try {
                state.redFlagGeojson = await state.redFlagFetchPromise;
            } catch (error) {
                state.redFlagFetchPromise = null;
                throw error;
            }
        }

        state.redFlagGeojson = normalizeFeatureCollection(state.redFlagGeojson);

        if (!map.getSource(RFW_SOURCE_ID)) {
            map.addSource(RFW_SOURCE_ID, { type: 'geojson', data: state.redFlagGeojson });
        } else {
            map.getSource(RFW_SOURCE_ID).setData(state.redFlagGeojson);
        }

        const beforeId = map.getLayer('wildfire-fill-large') ? 'wildfire-fill-large' : undefined;

        if (!map.getLayer(RFW_FILL_LAYER_ID)) {
            map.addLayer(
                {
                    id: RFW_FILL_LAYER_ID,
                    type: 'fill',
                    source: RFW_SOURCE_ID,
                    paint: { 'fill-color': RFW_COLOR, 'fill-opacity': 0.14 }
                },
                beforeId
            );
        } else {
            map.setLayoutProperty(RFW_FILL_LAYER_ID, 'visibility', 'visible');
        }

        if (!map.getLayer(RFW_LINE_LAYER_ID)) {
            map.addLayer(
                {
                    id: RFW_LINE_LAYER_ID,
                    type: 'line',
                    source: RFW_SOURCE_ID,
                    paint: { 'line-color': RFW_COLOR, 'line-width': 1.5, 'line-dasharray': [3, 2] }
                },
                beforeId
            );
        } else {
            map.setLayoutProperty(RFW_LINE_LAYER_ID, 'visibility', 'visible');
        }

        if (!redFlagInteractionsBound) {
            bindRedFlagInteractions();
            redFlagInteractionsBound = true;
        }
    }

    function hideRedFlagWarningsLayer() {
        if (map.getLayer(RFW_FILL_LAYER_ID)) {
            map.setLayoutProperty(RFW_FILL_LAYER_ID, 'visibility', 'none');
        }
        if (map.getLayer(RFW_LINE_LAYER_ID)) {
            map.setLayoutProperty(RFW_LINE_LAYER_ID, 'visibility', 'none');
        }
    }

    function bindRedFlagInteractions() {
        map.on('mouseenter', RFW_FILL_LAYER_ID, () => {
            map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', RFW_FILL_LAYER_ID, () => {
            map.getCanvas().style.cursor = '';
        });
        map.on('click', RFW_FILL_LAYER_ID, (event) => {
            const feature = event.features?.[0];
            if (!feature) return;
            const props = feature.properties || {};
            const effective = props.effective
                ? new Date(props.effective).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
                : 'Unknown';
            const expires = props.expires
                ? new Date(props.expires).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
                : 'Unknown';
            const html = `
                <div class="popup">
                    <h3>${escapeHtml(props.event || 'Red Flag Warning')}</h3>
                    <p class="popup-meta">${escapeHtml(props.areaDesc || '')}</p>
                    <p class="popup-meta">Effective ${effective} &rarr; ${expires}</p>
                    <p class="popup-source">Source: <a href="https://www.weather.gov/" target="_blank" rel="noopener">National Weather Service</a></p>
                </div>
            `;
            new mapboxgl.Popup({ closeButton: true, maxWidth: '320px' })
                .setLngLat(event.lngLat)
                .setHTML(html)
                .addTo(map);
        });
    }

    async function fetchRedFlagWarnings() {
        const fetchedAt = Date.now();
        const res = await fetch(RFW_ALERTS_ENDPOINT, { headers: { Accept: 'application/geo+json' } });
        if (!res.ok) {
            state.sourceStatus.redFlag = {
                status: 'error',
                fetchedAt,
                sourceUpdatedAt: null,
                error: `${res.status} ${res.statusText}`
            };
            renderSourceStatus();
            throw new Error(`Red flag warnings: ${res.status} ${res.statusText}`);
        }
        const alerts = normalizeFeatureCollection(await res.json());
        const directFeatures = [];
        const zoneFetches = [];
        const sourceTimes = [];

        (alerts.features || []).forEach((alert) => {
            const props = alert.properties || {};
            sourceTimes.push(parseDateLike(props.sent), parseDateLike(props.effective));
            const baseProps = {
                event: props.event,
                headline: props.headline,
                areaDesc: props.areaDesc,
                effective: props.effective,
                expires: props.expires,
                severity: props.severity,
                senderName: props.senderName
            };

            if (alert.geometry) {
                directFeatures.push({ type: 'Feature', geometry: alert.geometry, properties: baseProps });
                return;
            }

            // Most fire weather alerts are issued by zone rather than exact
            // polygon, so we resolve each affected zone's boundary separately.
            (props.affectedZones || []).forEach((zoneUrl) => {
                zoneFetches.push(
                    fetch(zoneUrl, { headers: { Accept: 'application/geo+json' } })
                        .then((zoneRes) => (zoneRes.ok ? zoneRes.json() : null))
                        .then((zoneFeature) => {
                            if (!zoneFeature?.geometry) return null;
                            return {
                                type: 'Feature',
                                geometry: zoneFeature.geometry,
                                properties: {
                                    ...baseProps,
                                    areaDesc: zoneFeature.properties?.name || baseProps.areaDesc
                                }
                            };
                        })
                        .catch(() => null)
                );
            });
        });

        const zoneFeatures = (await Promise.all(zoneFetches)).filter(Boolean);

        const collection = {
            type: 'FeatureCollection',
            features: [...directFeatures, ...zoneFeatures]
        };
        state.sourceStatus.redFlag = {
            status: collection.features.length ? 'loaded' : 'empty',
            fetchedAt,
            sourceUpdatedAt: maxTimestamp(sourceTimes),
            error: null
        };
        renderSourceStatus();
        return collection;
    }

    function initializePlaceSearch() {
        if (!refs.placeSearchForm) return;
        refs.placeSearchForm.addEventListener('submit', (event) => {
            event.preventDefault();
            window.clearTimeout(placeSearchTimer);
            const query = refs.placeSearchInput.value.trim();
            if (!query) {
                placeSearchRequestId += 1;
                closeSearchResults();
                return;
            }
            searchPlace(query);
        });
        refs.placeSearchInput.addEventListener('input', () => {
            const query = refs.placeSearchInput.value.trim();
            window.clearTimeout(placeSearchTimer);
            if (query.length < 2) {
                placeSearchRequestId += 1;
                closeSearchResults();
                return;
            }
            placeSearchTimer = window.setTimeout(() => {
                searchPlace(query, { autoSelect: false, showSearching: false });
            }, 250);
        });
        refs.useLocation?.addEventListener('click', useCurrentLocation);
        refs.clearPlace.addEventListener('click', clearSelectedPlace);
    }

    function useCurrentLocation() {
        if (!navigator.geolocation) {
            renderSearchMessage('Current location unavailable in this browser.');
            return;
        }
        refs.useLocation.disabled = true;
        renderSearchMessage('Finding your location...');
        navigator.geolocation.getCurrentPosition(
            (position) => {
                refs.useLocation.disabled = false;
                const { latitude, longitude } = position.coords || {};
                if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                    renderSearchMessage('Current location unavailable.');
                    return;
                }
                refs.placeSearchInput.value = 'Current location';
                closeSearchResults();
                setSelectedPlace({
                    label: 'Current location',
                    lng: longitude,
                    lat: latitude,
                    county: '',
                    shareable: false
                }, { focus: true });
            },
            () => {
                refs.useLocation.disabled = false;
                renderSearchMessage('Current location unavailable.');
            },
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
        );
    }

    async function searchPlace(query, options = {}) {
        const requestId = ++placeSearchRequestId;
        const autoSelect = options.autoSelect !== false;
        if (options.showSearching !== false) renderSearchMessage('Searching...');
        try {
            const url = new URL(`${MAPBOX_GEOCODE_ENDPOINT}${encodeURIComponent(query)}.json`);
            url.searchParams.set('access_token', MAPBOX_TOKEN);
            url.searchParams.set('country', 'US');
            url.searchParams.set('bbox', COLORADO_GEOCODE_BBOX);
            url.searchParams.set('limit', '5');
            url.searchParams.set('autocomplete', autoSelect ? 'false' : 'true');
            url.searchParams.set('types', 'address,place,postcode,poi,locality,neighborhood');
            url.searchParams.set('proximity', `${STATE_CENTER[0]},${STATE_CENTER[1]}`);

            const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
            const data = await response.json();
            if (requestId !== placeSearchRequestId) return;
            const results = (Array.isArray(data.features) ? data.features : [])
                .filter(isColoradoSearchResult)
                .slice(0, 5);

            if (!results.length) {
                if (refs.placeSearchInput.value.trim() === query) renderSearchMessage('No Colorado results found.');
                return;
            }

            if (autoSelect && (results.length === 1 || isStrongSearchResult(results))) {
                selectPlaceFromGeocode(results[0]);
                return;
            }

            if (refs.placeSearchInput.value.trim() === query) renderSearchChoices(results);
        } catch (error) {
            console.error('Place search failed:', error);
            if (requestId === placeSearchRequestId) renderSearchMessage('Place search unavailable.');
        }
    }

    function isColoradoSearchResult(feature) {
        const center = feature.center || [];
        const inBounds = center.length >= 2
            && center[0] >= -109.060253
            && center[0] <= -102.041524
            && center[1] >= 36.992426
            && center[1] <= 41.003444;
        if (inBounds) return true;
        return (feature.context || []).some((item) => /colorado|\bco\b/i.test(`${item.text || ''} ${item.short_code || ''}`));
    }

    function isStrongSearchResult(results) {
        const first = results[0];
        const second = results[1];
        const firstRelevance = Number(first?.relevance || 0);
        const secondRelevance = Number(second?.relevance || 0);
        return firstRelevance >= 0.98 && secondRelevance < 0.88;
    }

    function renderSearchChoices(results) {
        refs.placeSearchResults.innerHTML = results.map((feature, index) => `
            <button type="button" class="result-button" data-result-index="${index}">
                ${escapeHtml(feature.text || feature.place_name || 'Place')}
                <span class="result-context">${escapeHtml(feature.place_name || '')}</span>
            </button>
        `).join('');
        refs.placeSearchResults.classList.add('is-open');
        refs.placeSearchResults.querySelectorAll('[data-result-index]').forEach((button) => {
            button.addEventListener('click', () => {
                const index = Number(button.dataset.resultIndex);
                const feature = results[index];
                if (feature) selectPlaceFromGeocode(feature);
            });
        });
    }

    function renderSearchMessage(message) {
        refs.placeSearchResults.innerHTML = `<div class="result-button" role="status">${escapeHtml(message)}</div>`;
        refs.placeSearchResults.classList.add('is-open');
    }

    function closeSearchResults() {
        refs.placeSearchResults.innerHTML = '';
        refs.placeSearchResults.classList.remove('is-open');
    }

    function selectPlaceFromGeocode(feature) {
        const [lng, lat] = feature.center || [];
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
            renderSearchMessage('This result has no usable location.');
            return;
        }
        const label = feature.place_name || feature.text || 'Selected place';
        const county = extractCountyFromSearchResult(feature);
        refs.placeSearchInput.value = label;
        closeSearchResults();
        setSelectedPlace({ label, lng, lat, county }, { focus: true });
    }

    function extractCountyFromSearchResult(feature) {
        const context = [feature, ...(feature.context || [])];
        for (const item of context) {
            const id = item.id || '';
            const text = item.text || '';
            if (id.startsWith('district') || /\bcounty\b/i.test(text)) {
                const county = normalizeCountyName(text.replace(/\bcounty\b/ig, '').trim());
                if (county) return county;
            }
        }
        const countyMatch = (feature.place_name || '').match(/,\s*([^,]+?)\s+County,\s+Colorado/i);
        return countyMatch ? normalizeCountyName(countyMatch[1]) : '';
    }

    function setSelectedPlace(place, options = {}) {
        if (!options.preserveFire) {
            state.selectedFireId = null;
            clickPopup.remove();
        }
        state.selectedPlace = {
            label: place.label || 'Selected place',
            lng: Number(place.lng),
            lat: Number(place.lat),
            county: normalizeCountyName(place.county),
            shareable: place.shareable !== false
        };
        ensureSelectedPlaceLayer();
        updateSelectedPlaceLayer();
        renderSelectedPlace();
        renderNearestFires();
        if (options.focus !== false) {
            map.flyTo({ center: [state.selectedPlace.lng, state.selectedPlace.lat], zoom: Math.max(map.getZoom(), 9), essential: true });
            map.once('moveend', updateUrlState);
        }
        updateUrlState();
    }

    function clearSelectedPlace() {
        state.selectedPlace = null;
        if (map.getSource(SELECTED_PLACE_SOURCE_ID)) {
            map.getSource(SELECTED_PLACE_SOURCE_ID).setData({ ...EMPTY_COLLECTION });
        }
        refs.selectedPlace.hidden = true;
        refs.nearestFires.hidden = true;
        refs.nearestFiresList.innerHTML = '';
        refs.copyStatus.textContent = '';
        updateUrlState();
    }

    function ensureSelectedPlaceLayer() {
        if (!map.isStyleLoaded()) return;
        if (!map.getSource(SELECTED_PLACE_SOURCE_ID)) {
            map.addSource(SELECTED_PLACE_SOURCE_ID, { type: 'geojson', data: { ...EMPTY_COLLECTION } });
        }
        if (!map.getLayer(SELECTED_PLACE_LAYER_ID)) {
            map.addLayer({
                id: SELECTED_PLACE_LAYER_ID,
                type: 'circle',
                source: SELECTED_PLACE_SOURCE_ID,
                paint: {
                    'circle-radius': 7,
                    'circle-color': '#38bdf8',
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 2
                }
            });
        }
        updateSelectedPlaceLayer();
    }

    function updateSelectedPlaceLayer() {
        const source = map.getSource(SELECTED_PLACE_SOURCE_ID);
        if (!source) return;
        const place = state.selectedPlace;
        source.setData(place ? {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [place.lng, place.lat] },
                properties: { label: place.label }
            }]
        } : { ...EMPTY_COLLECTION });
    }

    function renderSelectedPlace() {
        const place = state.selectedPlace;
        if (!place) return;
        refs.selectedPlace.hidden = false;
        refs.selectedPlaceSummary.innerHTML = `
            <strong>${escapeHtml(place.label)}</strong>
            <span class="muted-line">${place.county ? `${escapeHtml(place.county)} County` : 'County unknown'} - Distance inferred.</span>
            <span class="muted-line">Evacuation zones are not drawn in this map. Use official county sources for current orders.</span>
            ${place.shareable === false ? '<span class="muted-line">Current location stays in this browser and is not included in shared links.</span>' : ''}
        `;
        refs.selectedPlaceLinks.innerHTML = renderCountyLinksHtml(place.county);
    }

    function renderNearestFires() {
        const place = state.selectedPlace;
        const features = safeFeatures(state.geojson);
        if (!place || !features.length) {
            refs.nearestFires.hidden = true;
            return;
        }
        const nearest = features
            .map((feature) => ({ feature, distance: distanceToFire(place, feature) }))
            .filter((item) => item.distance)
            .sort((a, b) => a.distance.sortMiles - b.distance.sortMiles)
            .slice(0, 5);

        refs.nearestFires.hidden = !nearest.length;
        refs.nearestFiresList.innerHTML = nearest.map((item) => {
            const props = item.feature.properties || {};
            return `
                <li>
                    <button type="button" class="fire-list-button nearest-fire-button" data-fire-id="${escapeAttr(props.__id || '')}">
                        <strong>${escapeHtml(props.__primaryName || 'Unnamed fire')}</strong>
                        <span class="muted-line">${escapeHtml(item.distance.label)}</span>
                    </button>
                </li>
            `;
        }).join('');
        refs.nearestFiresList.querySelectorAll('.fire-list-button[data-fire-id]').forEach((button) => {
            button.addEventListener('click', () => {
                const feature = state.featureLookupById.get(button.dataset.fireId);
                if (feature) focusFeature(feature);
            });
        });
    }

    function distanceToFire(place, feature) {
        if (!place || !feature?.geometry) return null;
        const props = feature.properties || {};
        if (props.__featureType === 'point' || feature.geometry.type === 'Point') {
            const center = getFeaturePoint(feature);
            if (!center) return null;
            const miles = haversineMiles([place.lng, place.lat], center);
            return {
                sortMiles: miles,
                miles,
                label: `${formatMiles(miles)} mi to incident point. Perimeter unavailable.`
            };
        }
        if (pointInGeometry([place.lng, place.lat], feature.geometry)) {
            return { sortMiles: 0, miles: 0, label: 'Inside mapped perimeter.' };
        }
        const miles = distancePointToGeometryMiles([place.lng, place.lat], feature.geometry);
        if (!Number.isFinite(miles)) return null;
        return {
            sortMiles: miles,
            miles,
            label: `${formatMiles(miles)} mi to perimeter. Distance inferred.`
        };
    }

    function getFeaturePoint(feature) {
        if (feature.geometry?.type === 'Point') return feature.geometry.coordinates;
        const centroid = feature.properties?.__centroid;
        return centroid ? [centroid.lng, centroid.lat] : null;
    }

    function distancePointToGeometryMiles(point, geometry) {
        const rings = getGeometryRings(geometry);
        let min = Infinity;
        rings.forEach((ring) => {
            for (let i = 0; i < ring.length - 1; i += 1) {
                min = Math.min(min, distancePointToSegmentMiles(point, ring[i], ring[i + 1]));
            }
        });
        return min;
    }

    function pointInGeometry(point, geometry) {
        if (geometry.type === 'Polygon') {
            return pointInRing(point, geometry.coordinates?.[0] || []);
        }
        if (geometry.type === 'MultiPolygon') {
            return (geometry.coordinates || []).some((polygon) => pointInRing(point, polygon?.[0] || []));
        }
        return false;
    }

    function pointInRing(point, ring) {
        if (!ring.length) return false;
        const [x, y] = point;
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            const intersect = ((yi > y) !== (yj > y))
                && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function getGeometryRings(geometry) {
        if (geometry.type === 'Polygon') return geometry.coordinates || [];
        if (geometry.type === 'MultiPolygon') return (geometry.coordinates || []).flatMap((polygon) => polygon || []);
        return [];
    }

    function distancePointToSegmentMiles(point, start, end) {
        const lat0 = ((point[1] + start[1] + end[1]) / 3) * Math.PI / 180;
        const project = ([lng, lat]) => ({
            x: lng * Math.cos(lat0) * 69.172,
            y: lat * 69.0
        });
        const p = project(point);
        const a = project(start);
        const b = project(end);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
        const x = a.x + t * dx;
        const y = a.y + t * dy;
        return Math.hypot(p.x - x, p.y - y);
    }

    function haversineMiles(a, b) {
        const radius = 3958.8;
        const toRad = (value) => value * Math.PI / 180;
        const dLat = toRad(b[1] - a[1]);
        const dLng = toRad(b[0] - a[0]);
        const lat1 = toRad(a[1]);
        const lat2 = toRad(b[1]);
        const h = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
        return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    async function loadCountySources() {
        const fetchedAt = Date.now();
        try {
            const response = await fetch(COUNTY_SOURCES_ENDPOINT, { headers: { Accept: 'application/json' } });
            if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
            const records = await response.json();
            setCountySources(records, fetchedAt);
        } catch (error) {
            console.error('County source load failed:', error);
            state.countySources = {};
            state.sourceStatus.county = { status: 'error', fetchedAt, sourceUpdatedAt: null, error: error.message };
        }
        renderSourceStatus();
        if (state.selectedPlace) renderSelectedPlace();
    }

    function setCountySources(records, fetchedAt, error = null) {
        state.countySources = normalizeCountySources(records);
        const count = Object.keys(state.countySources).length;
        state.sourceStatus.county = {
            status: count ? 'loaded' : 'empty',
            fetchedAt,
            sourceUpdatedAt: maxTimestamp(Object.values(state.countySources).map((record) => Date.parse(record.lastChecked || ''))),
            error
        };
        return count;
    }

    function normalizeCountySources(records) {
        const map = {};
        (Array.isArray(records) ? records : []).forEach((record) => {
            const county = normalizeCountyName(record.county);
            if (county) map[county.toLowerCase()] = { ...record, county };
        });
        return map;
    }

    function coverageForCounty(county) {
        const key = normalizeCountyName(county).toLowerCase();
        return key ? state.countySources[key] : null;
    }

    function renderCountyLinksHtml(county) {
        const normalized = normalizeCountyName(county);
        if (!normalized) {
            return '<span class="muted-line">County emergency links only. County not identified for this item.</span>';
        }
        const record = coverageForCounty(normalized);
        if (!record) {
            const countyStatus = state.sourceStatus.county?.status;
            if (countyStatus === 'loading') {
                return '<span class="muted-line">County emergency links are still loading. Use official county, sheriff, or emergency-management channels for current orders.</span>';
            }
            if (countyStatus === 'error') {
                return '<span class="muted-line">County emergency links are unavailable. Use official county, sheriff, or emergency-management channels for current orders.</span>';
            }
            return `<span class="muted-line">${escapeHtml(normalized)} County sources have not been reviewed yet. Use county, sheriff, or emergency-management channels.</span>`;
        }

        const links = [];
        addVerifiedLink(links, record.emergencyUrl, record.emergencyVerified, 'Emergency management');
        addVerifiedLink(links, record.sheriffUrl, record.sheriffVerified, 'Sheriff/public safety');
        addVerifiedLink(links, record.alertUrl, record.alertVerified, 'Alert signup');
        addVerifiedLink(links, record.evacuationInfoUrl, record.evacuationInfoVerified, 'Evacuation information');
        addVerifiedLink(links, record.evacuationMapUrl, record.evacuationMapVerified, countyMapLabel(record.evacuationMapType));

        const checked = record.lastChecked ? ` Links checked ${escapeHtml(record.lastChecked)}.` : '';
        return `
            <span class="muted-line">County emergency links only. Evacuation zones are not drawn in this map.${checked}</span>
            ${links.length ? `<div class="county-links">${links.join('')}</div>` : '<span class="muted-line">No verified county-specific links are available.</span>'}
        `;
    }

    function addVerifiedLink(links, url, verified, label) {
        if (!verified || !url || !/^https?:\/\//i.test(url)) return;
        links.push(`<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`);
    }

    function countyMapLabel(type) {
        switch (type) {
            case 'zones':
                return 'External evacuation-zone lookup';
            case 'incident':
                return 'External incident map';
            case 'current':
                return 'External current-alert map';
            default:
                return 'External official map';
        }
    }

    function initializeShareControls() {
        refs.copyLink.addEventListener('click', copyCurrentLink);
    }

    async function copyCurrentLink() {
        const url = buildShareUrl({ selectedPlaceView: true });
        const omitsPrivateLocation = state.selectedPlace?.shareable === false;
        try {
            await navigator.clipboard.writeText(url);
            refs.copyStatus.textContent = omitsPrivateLocation ? 'Link copied without current location.' : 'Link copied.';
        } catch (error) {
            const textarea = document.createElement('textarea');
            textarea.value = url;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.left = '-9999px';
            document.body.append(textarea);
            textarea.select();
            const copied = document.execCommand('copy');
            textarea.remove();
            refs.copyStatus.textContent = copied
                ? (omitsPrivateLocation ? 'Link copied without current location.' : 'Link copied.')
                : 'Copy unavailable.';
        }
    }

    function readUrlState() {
        const params = new URLSearchParams(window.location.search);
        const sizesParam = params.has('sizes') ? params.get('sizes') : null;
        const lng = parseFinite(params.get('lng'));
        const lat = parseFinite(params.get('lat'));
        const centerLng = parseFinite(params.get('clng'));
        const centerLat = parseFinite(params.get('clat'));
        const zoom = parseFinite(params.get('z'));
        const style = MAPBOX_STYLES[params.get('style')] ? params.get('style') : null;
        const sizes = (sizesParam || '')
            .split(',')
            .map((item) => item.trim())
            .filter((item) => BUCKET_MAP.has(item));
        const containment = ['all', 'low', 'medium', 'high', 'contained'].includes(params.get('containment'))
            ? params.get('containment')
            : null;
        return {
            selectedPlace: Number.isFinite(lng) && Number.isFinite(lat) ? {
                lng,
                lat,
                label: params.get('place') || 'Shared place',
                county: params.get('county') || ''
            } : null,
            mapView: Number.isFinite(centerLng) && Number.isFinite(centerLat) && Number.isFinite(zoom)
                ? { center: [centerLng, centerLat], zoom: Math.max(5, Math.min(14, zoom)) }
                : null,
            style,
            sizesParam,
            sizes,
            containment,
            showAirQuality: parseBooleanParam(params.get('aq')),
            showRedFlagWarnings: parseBooleanParam(params.get('rfw')),
            fireKey: params.get('fire') || '',
            timelineTs: parseFinite(params.get('t'))
        };
    }

    function applyInitialUrlState(urlState) {
        if (urlState.style) state.baseStyle = urlState.style;
        if (urlState.sizesParam !== null) state.activeSizeBuckets = new Set(urlState.sizes);
        if (urlState.containment) state.containmentFilter = urlState.containment;
        if (urlState.showAirQuality !== null) state.showAirQuality = urlState.showAirQuality;
        if (urlState.showRedFlagWarnings !== null) {
            state.showRedFlagWarnings = urlState.showRedFlagWarnings;
            if (!state.showRedFlagWarnings) {
                state.sourceStatus.redFlag = { status: 'disabled', fetchedAt: null, sourceUpdatedAt: null, error: null };
            }
        }
        if (urlState.selectedPlace) state.selectedPlace = {
            ...urlState.selectedPlace,
            county: normalizeCountyName(urlState.selectedPlace.county)
        };
        state.initialMapView = urlState.mapView;
        state.restoredFireKey = urlState.fireKey;
        state.initialTimelineTs = urlState.timelineTs;
    }

    function applyInitialControlState() {
        syncStyleButtons();
        refs.containmentFilter.value = state.containmentFilter;
        refs.airQualityToggle.checked = state.showAirQuality;
        refs.redFlagToggle.checked = state.showRedFlagWarnings;
        if (state.selectedPlace) {
            refs.placeSearchInput.value = state.selectedPlace.label;
        }
    }

    function restoreUrlStateAfterData() {
        let restoredSelectedPlace = false;
        if (state.selectedPlace) {
            setSelectedPlace(state.selectedPlace, { focus: false, preserveFire: Boolean(state.restoredFireKey) });
            restoredSelectedPlace = true;
        }
        if (Number.isFinite(state.initialTimelineTs) && state.timeline.enabled) {
            const clamped = Math.max(state.timeline.minTs, Math.min(state.timeline.maxTs, state.initialTimelineTs));
            state.timeline.currentTs = clamped;
            refs.timelineRange.value = Math.round((clamped - state.timeline.minTs) / DAY_MS);
            updateTimelineLabel(clamped);
            updateMapFilters();
        }
        if (state.restoredFireKey) {
            const key = normalizeKey(state.restoredFireKey);
            const feature = state.featureLookupById.get(key) || state.featureLookupByName.get(key);
            if (feature) {
                focusFeature(feature, { updateUrl: false });
                return;
            }
            state.restoredFireKey = null;
        }
        if (restoredSelectedPlace) {
            const zoom = Math.max(state.initialMapView?.zoom || map.getZoom(), 9);
            map.jumpTo({ center: [state.selectedPlace.lng, state.selectedPlace.lat], zoom });
            updateUrlState();
            return;
        }
        if (state.initialMapView) {
            map.jumpTo({ center: state.initialMapView.center, zoom: state.initialMapView.zoom });
        }
    }

    function updateUrlState() {
        try {
            window.history.replaceState(null, '', buildShareUrl());
        } catch (error) {
            console.warn('Unable to update URL state:', error);
        }
    }

    function buildShareUrl(options = {}) {
        const url = new URL(window.location.href);
        const params = url.searchParams;
        const selectedPlaceIsShareable = state.selectedPlace && state.selectedPlace.shareable !== false;
        const selectedPlaceShouldDriveView = selectedPlaceIsShareable && (options.selectedPlaceView || !state.selectedFireId);
        const shouldStoreMapView = !(state.selectedPlace?.shareable === false && !state.selectedFireId);
        const center = selectedPlaceShouldDriveView
            ? { lng: state.selectedPlace.lng, lat: state.selectedPlace.lat }
            : map.getCenter();
        const zoom = selectedPlaceShouldDriveView
            ? Math.max(map.getZoom(), 9)
            : map.getZoom();
        params.set('style', state.baseStyle);
        params.set('aq', state.showAirQuality ? '1' : '0');
        params.set('rfw', state.showRedFlagWarnings ? '1' : '0');
        params.set('containment', state.containmentFilter);
        params.set('sizes', [...state.activeSizeBuckets].join(','));
        if (shouldStoreMapView) {
            params.set('clng', center.lng.toFixed(5));
            params.set('clat', center.lat.toFixed(5));
            params.set('z', zoom.toFixed(2));
        } else {
            ['clng', 'clat', 'z'].forEach((key) => params.delete(key));
        }
        if (Number.isFinite(state.timeline.currentTs)) {
            params.set('t', String(Math.round(state.timeline.currentTs)));
        } else {
            params.delete('t');
        }
        if (selectedPlaceIsShareable) {
            params.set('lng', state.selectedPlace.lng.toFixed(5));
            params.set('lat', state.selectedPlace.lat.toFixed(5));
            params.set('place', state.selectedPlace.label);
            if (state.selectedPlace.county) params.set('county', state.selectedPlace.county);
            else params.delete('county');
        } else {
            ['lng', 'lat', 'place', 'county'].forEach((key) => params.delete(key));
        }
        if (state.selectedFireId && !options.selectedPlaceView) params.set('fire', state.selectedFireId);
        else params.delete('fire');
        return url.toString();
    }

    function renderSourceStatus() {
        const parts = [
            compactSourceSummary('Fire perimeters', state.sourceStatus.fires, 'no perimeters returned'),
            compactSourceSummary('Incident points', state.sourceStatus.incidents, 'none returned'),
            compactRedFlagSummary(),
            compactAqiSummary(),
            compactCountySummary()
        ].filter(Boolean);
        refs.sourceStatus.innerHTML = `<div class="source-line">${escapeHtml(parts.join(' '))}</div>`;
    }

    function compactSourceSummary(label, status, emptyText) {
        if (status.status === 'error') return `${label}: unavailable.`;
        if (status.status === 'empty') return `${label}: ${emptyText}.`;
        if (status.status === 'loaded' || status.status === 'available') {
            const timeText = Number.isFinite(status.sourceUpdatedAt)
                ? `updated ${formatCompactDateTime(status.sourceUpdatedAt)}`
                : `checked ${formatTimeOnly(status.fetchedAt)}`;
            return `${label} ${timeText}.`;
        }
        return `${label}: loading.`;
    }

    function compactRedFlagSummary() {
        const status = state.sourceStatus.redFlag;
        if (status.status === 'empty') return 'NWS: no active red flag warnings.';
        if (status.status === 'loaded') return `NWS loaded ${formatTimeOnly(status.fetchedAt)}.`;
        if (status.status === 'error') return 'NWS red flag warnings unavailable.';
        if (status.status === 'disabled') return 'NWS red flag layer off.';
        return 'NWS loading.';
    }

    function compactAqiSummary() {
        if (state.sourceStatus.aqi.status === 'error') return 'AQI overlay unavailable.';
        return state.showAirQuality ? 'AQI overlay on.' : '';
    }

    function compactCountySummary() {
        const status = state.sourceStatus.county;
        if (status.status === 'loaded') return 'County links are external official sources.';
        if (status.status === 'error') return 'County links unavailable.';
        if (status.status === 'empty') return 'No reviewed county links loaded.';
        return 'County links loading.';
    }

    function parseFinite(value) {
        if (value === null || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function parseBooleanParam(value) {
        if (value === '1' || value === 'true') return true;
        if (value === '0' || value === 'false') return false;
        return null;
    }

    function normalizeCountyName(value = '') {
        const cleaned = String(value)
            .replace(/\bcity\s+(and|&)\s+county\s+of\b/ig, '')
            .replace(/\bcounty\b/ig, '')
            .replace(/\bcolorado\b/ig, '')
            .replace(/\bunited states\b/ig, '')
            .replace(/\busa\b/ig, '')
            .replace(/\bus\b/ig, '')
            .replace(/\bco\b\.?/ig, '')
            .replace(/[,:;()]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!cleaned) return '';
        return cleaned.split(' ').map((part) => part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : '').join(' ');
    }

    function formatMiles(value) {
        if (value < 0.1) return '<0.1';
        if (value < 10) return value.toFixed(1);
        return Math.round(value).toString();
    }

    function formatDateTime(ts) {
        return Number.isFinite(ts)
            ? new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
            : 'unknown time';
    }

    function formatTimeOnly(ts) {
        return Number.isFinite(ts)
            ? new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
            : 'unknown time';
    }

    function formatCompactDateTime(ts) {
        return Number.isFinite(ts)
            ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
            : 'unknown time';
    }

    function escapeHtml(value = '') {
        return String(value).replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    function escapeAttr(value = '') {
        return escapeHtml(value);
    }

    function updateMapFilters() {
        // Check for actual layer names
        if (!map.getLayer('wildfire-fill-large')) return;

        const acresExpr = ['to-number', ['coalesce', ['get', '__acres'], 0]];
        const isPolygon = ['any',
            ['==', ['geometry-type'], 'Polygon'],
            ['==', ['geometry-type'], 'MultiPolygon']
        ];
        const isPoint = ['==', ['get', '__featureType'], 'point'];

        const baseFilters = ['all'];
        const sizeFilter = buildSizeFilterExpression();
        const containmentFilter = buildContainmentFilterExpression();
        const timelineFilter = buildTimelineFilterExpression();

        if (sizeFilter) baseFilters.push(sizeFilter);
        if (containmentFilter) baseFilters.push(containmentFilter);
        if (timelineFilter) baseFilters.push(timelineFilter);

        // Polygon layers: Large fires (>= SMALL_FIRE_ACRES)
        const largePolyFilter = ['all', isPolygon, ...baseFilters.slice(1), ['>=', acresExpr, SMALL_FIRE_ACRES]];
        // Polygon layers: Small fires (< SMALL_FIRE_ACRES)
        const smallPolyFilter = ['all', isPolygon, ...baseFilters.slice(1), ['<', acresExpr, SMALL_FIRE_ACRES]];
        // Point layers - must have __featureType='point'
        const pointFilter = ['all', isPoint, ...baseFilters.slice(1)];

        map.setFilter('wildfire-fill-large', largePolyFilter);
        map.setFilter('wildfire-outline-large', largePolyFilter);
        map.setFilter('wildfire-fill-small', smallPolyFilter);
        map.setFilter('wildfire-outline-small', smallPolyFilter);
        map.setFilter('wildfire-small-symbol', smallPolyFilter);

        // Point layers
        if (map.getLayer('wildfire-point-symbol')) {
            map.setFilter('wildfire-point-symbol', pointFilter);
        }
    }

    function buildSizeFilterExpression() {
        if (state.activeSizeBuckets.size === 0) {
            return ['==', ['get', '__matchesNoFeatures'], true];
        }
        if (state.activeSizeBuckets.size === SIZE_BUCKETS.length) {
            return null;
        }
        const acresExpr = ['to-number', ['coalesce', ['get', '__acres'], 0]];
        const anyExpr = ['any'];
        state.activeSizeBuckets.forEach((bucketId) => {
            const bucket = BUCKET_MAP.get(bucketId);
            if (!bucket) return;
            const clauses = ['all', ['>=', acresExpr, bucket.min]];
            if (bucket.max !== null) {
                clauses.push(['<', acresExpr, bucket.max]);
            }
            anyExpr.push(clauses);
        });
        return anyExpr.length > 1 ? anyExpr : null;
    }

    function buildContainmentFilterExpression() {
        const containmentExpr = ['to-number', ['coalesce', ['get', '__containment'], -1]];
        switch (state.containmentFilter) {
            case 'low':
                return ['all', ['>=', containmentExpr, 0], ['<', containmentExpr, 25]];
            case 'medium':
                return ['all', ['>=', containmentExpr, 25], ['<', containmentExpr, 75]];
            case 'high':
                return ['>=', containmentExpr, 75];
            case 'contained':
                return ['>=', containmentExpr, 100];
            default:
                return null;
        }
    }

    function buildTimelineFilterExpression() {
        if (!state.timeline.enabled || !Number.isFinite(state.timeline.currentTs)) {
            return null;
        }
        const discoveryExpr = ['to-number', ['coalesce', ['get', '__discoveryTs'], -1]];
        return ['any', ['==', discoveryExpr, -1], ['<=', discoveryExpr, state.timeline.currentTs]];
    }

    function blockInitialization(message) {
        refs.loading.classList.add('is-hidden');
        showError(message);
    }

    function showError(message) {
        refs.errorBanner.textContent = `Warning: ${message}`;
        refs.errorBanner.hidden = false;
    }

    function formatNumber(value) {
        return new Intl.NumberFormat('en-US').format(value);
    }

    function applyMapPadding() {
        if (!map) return;
        const hud = document.querySelector('.hud');
        const hudWidth = hud ? Math.ceil(hud.getBoundingClientRect().width) : 0;
        const isOverlayLayout = window.matchMedia('(min-width: 981px)').matches;
        state.mapPadding = {
            top: 20,
            bottom: 20,
            left: 20,
            right: isOverlayLayout ? hudWidth + 48 : 20
        };
        map.setPadding(state.mapPadding);
    }
})();
