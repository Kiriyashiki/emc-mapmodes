import './font.css'
import './style.css'
import {
  CLAIMS_GRADIENT,
  DENSITY_STOPS,
  NATION_CLAIMS_GRADIENT,
  NATION_POPULATION_GRADIENT,
  POPULATION_GRADIENT
} from './gradients.js';
import {translations} from "./tl.js";

// IndexedDB functions
const DB_NAME = 'emcMapmodesDB';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('townData')) {
        db.createObjectStore('townData', {keyPath: 'id'});
      }
    };
    request.onsuccess = (event) => {
      resolve(event.target.result);
    };
    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

async function storeTownData(data) {
  const db = await openDB();
  const transaction = db.transaction(['townData'], 'readwrite');
  const store = transaction.objectStore('townData');
  const item = {
    id: 'townData',
    data: data,
    timestamp: Date.now()
  };
  store.put(item);
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = (event) => reject(event.target.error);
  });
}

async function getTownData() {
  const db = await openDB();
  const transaction = db.transaction(['townData'], 'readonly');
  const store = transaction.objectStore('townData');
  const request = store.get('townData');
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

// Configuration
const baseUrl = 'https://map.earthmc.net/tiles/minecraft_overworld';
const baseUrlCors = `https://feur.hainaut.xyz/proxy?url=`;
const baseUrlApi = `${baseUrlCors}https://api.earthmc.net/v4`
const maxNativeZoom = 5;
const maxZoom = 7;
const minZoom = 0;
const tileSize = 512;

// Calculate transformation factor to ensure 1 map unit = 1 pixel at maxNativeZoom
const scaleFactor = 1 / Math.pow(2, maxNativeZoom);

const map = L.map('map', {
  crs: L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(scaleFactor, 0, scaleFactor, 0)
  }),
  center: [0, 0],
  zoom: minZoom,
  minZoom: minZoom,
  maxZoom: maxZoom,
  zoomSnap: 1,
  zoomDelta: 1,
  maxBounds: [
    [-32256, -64512],
    [32256, 64512],
  ]
});

// Custom tile layer using fetch
const FetchTileLayer = L.GridLayer.extend({
  createTile: function (coords) {
    const tile = document.createElement('img');
    const size = this.getTileSize();
    tile.width = size.x;
    tile.height = size.y;
    tile.style.imageRendering = "pixelated";
    tile.style.imageRendering = "-webkit-optimize-contrast";
    tile.style.imageRendering = "crisp-edges";
    tile.style.msInterpolationMode = "nearest-neighbor";

    const tileUrl = `${baseUrlCors}${baseUrl}/${coords.z}/${coords.x}_${coords.y}.png`;

    fetch(tileUrl)
      .then(response => {
        if (!response.ok) {
          throw new Error(`Tile fetch failed: ${response.status}`);
        }
        return response.blob();
      })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        tile.src = url;
        tile.onload = () => {
          URL.revokeObjectURL(url);
        };
      })
      .catch(error => {
        console.error(`Error fetching tile ${tileUrl}:`, error);
      });

    return tile;
  }
});

const tileLayer = new FetchTileLayer({
  tileSize: tileSize,
  minZoom: minZoom,
  maxZoom: maxZoom,
  minNativeZoom: 0,
  maxNativeZoom: maxNativeZoom,
  noWrap: true,
  attribution: 'Map Data <a href="https://map.earthmc.net/">EMC</a>'
});


tileLayer.addTo(map);

// Grid Layer
const GridLayer = L.GridLayer.extend({
  createTile: function (coords) {
    const tile = document.createElement('canvas');
    const size = this.getTileSize();
    tile.width = size.x;
    tile.height = size.y;

    const ctx = tile.getContext('2d');

    // Calculate grid size based on zoom level
    // At maxNativeZoom (3), 1 pixel = 1 block
    // We want 16x16 block grid
    const zoomScale = Math.pow(2, coords.z - maxNativeZoom);
    const blockSize = 16 * zoomScale;
    const bigBlockSize = 512 * zoomScale;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;

    // Draw 16x16 grid
    if (blockSize >= 4) { // Only draw if grid is visible enough
      ctx.beginPath();
      for (let x = 0; x <= size.x; x += blockSize) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size.y);
      }
      for (let y = 0; y <= size.y; y += blockSize) {
        ctx.moveTo(0, y);
        ctx.lineTo(size.x, y);
      }
      ctx.stroke();
    }

    // Draw 512x512 grid (thicker)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();

    const tileX = coords.x * size.x;
    const tileY = coords.y * size.y;

    const startX = (bigBlockSize - (((tileX % bigBlockSize) + bigBlockSize) % bigBlockSize)) % bigBlockSize;
    const startY = (bigBlockSize - (((tileY % bigBlockSize) + bigBlockSize) % bigBlockSize)) % bigBlockSize;

    for (let x = startX; x <= size.x; x += bigBlockSize) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size.y);
    }
    for (let y = startY; y <= size.y; y += bigBlockSize) {
      ctx.moveTo(0, y);
      ctx.lineTo(size.x, y);
    }
    ctx.stroke();

    return tile;
  }
});

const gridLayer = new GridLayer({tileSize: tileSize, minZoom: minZoom, maxZoom: maxZoom});

// Layer Groups
const layerGroups = {
  default: L.layerGroup(),
  population: L.layerGroup(),
  claims: L.layerGroup(),
  claimLimit: L.layerGroup(),
  nationPopulation: L.layerGroup(),
  nationClaims: L.layerGroup(),
  founded: L.layerGroup(),
  density: L.layerGroup()
};

const rangeLayerGroup = L.layerGroup().addTo(map);

function getInitialLanguage() {
  const storedLang = localStorage.getItem('emc-mapmodes-lang');
  if (storedLang && translations[storedLang]) {
    return storedLang;
  }

  const browserLangs = navigator.languages || [navigator.language || 'en'];
  for (const lang of browserLangs) {
    if (translations[lang]) return lang;
    const baseLang = lang.split('-')[0];
    if (translations[baseLang]) return baseLang;
  }

  return 'en';
}

let currentLang = getInitialLanguage();

function t(key) {
  return translations[currentLang][key] || key;
}

const layerKeys = {
  default: "political",
  population: "population",
  claims: "claims",
  claimLimit: "claimLimit",
  nationPopulation: "nationPopulation",
  nationClaims: "nationClaims",
  founded: "founded",
  density: "density"
};

let currentMode = 'default';
let minDateGlobal = Infinity;
let maxDateGlobal = -Infinity;
let processedMarkersData = [];
let activeNation = null;
let activeNationData = null;
let allTownsDataCache = null;
let lastTownDataLoadTime = null;
let rankingsOutlinesEnabled = localStorage.getItem('emc-mapmodes-rankings-outlines') !== 'false';

// Ranking colors
const RANKING_COLORS = {
  gold: '#FFD700',
  silver: '#C0C0C0',
  bronze: '#CD7F32'
};

function getColor(val, grad) {
  return grad.find(s => val >= s.min)?.color || "#000000";
}

function getDateColor(ts, min, max) {
  if (min === max) return "hsl(240, 100%, 50%)";
  const ratio = (ts - min) / (max - min);
  const hue = 240 - (ratio * 240);
  return `hsl(${hue}, 100%, 50%)`;
}

function getDensityColor(val) {
  if (val <= DENSITY_STOPS[0].val) return `rgb(${DENSITY_STOPS[0].color.r},${DENSITY_STOPS[0].color.g},${DENSITY_STOPS[0].color.b})`;
  if (val >= DENSITY_STOPS.at(-1).val) {
    const c = DENSITY_STOPS.at(-1).color;
    return `rgb(${c.r},${c.g},${c.b})`;
  }

  for (let i = 0; i < DENSITY_STOPS.length - 1; i++) {
    const start = DENSITY_STOPS[i];
    const end = DENSITY_STOPS[i + 1];
    if (val >= start.val && val <= end.val) {
      const t = (val - start.val) / (end.val - start.val);
      const r = Math.round(start.color.r + t * (end.color.r - start.color.r));
      const g = Math.round(start.color.g + t * (end.color.g - start.color.g));
      const b = Math.round(start.color.b + t * (end.color.b - start.color.b));
      return `rgb(${r},${g},${b})`;
    }
  }
  return "#000000";
}

// Calculate rankings for towns by a metric
function calculateRankings(data, metric) {
  const sorted = [...data].sort((a, b) => b[metric] - a[metric]);
  const rankings = {};

  sorted.forEach((item, index) => {
    const townName = item.popupData.name;
    let rank = 'none';

    if (index === 0) {
      rank = 'gold';
    } else if (index < 3) {
      rank = 'silver';
    } else if (index < 10) {
      rank = 'bronze';
    }

    rankings[townName] = {rank, position: index + 1, value: item[metric]};
  });

  return rankings;
}

// Calculate rankings for nations by a metric
function calculateNationRankings(data, metric) {
  // Group by nation and aggregate
  const nationAggregates = {};

  data.forEach(item => {
    if (item.popupData.nation) {
      const nation = item.popupData.nation;
      if (!nationAggregates[nation]) {
        nationAggregates[nation] = {[metric]: 0};
      }
      nationAggregates[nation][metric] += item[metric];
    }
  });

  // Sort and rank
  const sorted = Object.entries(nationAggregates)
    .sort((a, b) => b[1][metric] - a[1][metric]);

  const rankings = {};
  sorted.forEach(([nation, stats], index) => {
    let rank = 'none';

    if (index === 0) {
      rank = 'gold';
    } else if (index < 3) {
      rank = 'silver';
    } else if (index < 10) {
      rank = 'bronze';
    }

    rankings[nation] = {rank, position: index + 1, value: stats[metric]};
  });

  return rankings;
}

// Get border color based on ranking
function getRankingBorderColor(rankingInfo) {
  if (!rankingsOutlinesEnabled || !rankingInfo) return null;
  return RANKING_COLORS[rankingInfo.rank] || null;
}

// Calculate founded date groupings (oldest day, 7 days, 28 days)
function calculateFoundedGroupings(data, minDate, maxDate) {
  const groupings = {};

  data.forEach(item => {
    if (item.foundedTs === null) {
      groupings[item.popupData.name] = 'unknown';
      return;
    }

    const timeDiffMs = item.foundedTs - minDate;
    const timeDiffDays = timeDiffMs / (1000 * 60 * 60 * 24);

    if (timeDiffDays < 1) {
      groupings[item.popupData.name] = 'day';
    } else if (timeDiffDays < 7) {
      groupings[item.popupData.name] = 'week';
    } else if (timeDiffDays < 28) {
      groupings[item.popupData.name] = 'month';
    } else {
      groupings[item.popupData.name] = 'other';
    }
  });

  return groupings;
}

const FOUNDED_GROUPING_COLORS = {
  day: '#FFD700',    // gold
  week: '#C0C0C0',   // silver
  month: '#CD7F32',  // bronze
  other: null,
  unknown: null
};

// Add default layer to map initially
layerGroups.default.addTo(map);

// Initialize UI text immediately
updateUIText();

// Fetch and display markers
fetchMarkers()
  .then(async data => {
    let layer;
    for (let l of data) {
      if (l.id === "towny") {
        layer = l;
        break;
      }
    }
    if (layer) {
      processMarkers(layer);
    }
    setupControls();
    setupLegend();
    setupSettings();
    updateUIText();

    // Load town data (from cache or API) and wait for it to complete
    await loadTownDataAtStartup();

    // Hide loading overlay only after town data is fully loaded
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) {
      loadingOverlay.style.display = 'none';
    }
  })
  .catch(error => {
    console.error('Error loading markers:', error);

    // Show error state
    const loadingContent = document.getElementById('loading-content');
    const errorContent = document.getElementById('error-content');
    const errorText = document.getElementById('error-text');

    if (loadingContent) loadingContent.style.display = 'none';
    if (errorContent) errorContent.style.display = 'block';
    if (errorText) errorText.innerText = t('error');
  });

function fetchMarkers() {
  return fetch(`${baseUrlCors}${baseUrl}/markers.json`)
    .then(response => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    });
}

async function loadTownDataAtStartup() {
  try {
    // Try to load from IndexedDB cache first
    const cached = await getTownData();
    const now = Date.now();
    const cacheAge = cached ? now - cached.timestamp : Infinity;
    const tenMinutes = 10 * 60 * 1000;

    // If cache exists and is less than 10 minutes old, use it
    if (cached && cacheAge < tenMinutes) {
      allTownsDataCache = cached.data;
      lastTownDataLoadTime = cached.timestamp;
      enrichProcessedDataWithApiData(cached.data);
      renderLayers();
      console.log('Loaded town data from cache.');
    } else {
      // Cache is expired or doesn't exist, fetch fresh data from API
      const townNames = processedMarkersData.map(item => item.popupData.name);
      const results = [];
      const batchSize = 100;

      for (let i = 0; i < townNames.length; i += batchSize) {
        const batch = townNames.slice(i, i + batchSize);
        try {
          const response = await fetch(`${baseUrlApi}/towns`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              query: batch,
              template: {
                name: true,
                coordinates: true,
                status: true,
                stats: true
              }
            })
          });
          if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data)) {
              results.push(...data);
            }
          }
        } catch (error) {
          console.error("Error fetching town batch:", error);
        }
      }

      if (results.length > 0) {
        allTownsDataCache = results;
        lastTownDataLoadTime = Date.now();
        enrichProcessedDataWithApiData(results);

        // Store in IndexedDB
        storeTownData(results)
          .then(() => {
            console.log('Town data loaded from API and cached.');
          })
          .catch(error => {
            console.error('Error storing town data in IndexedDB:', error);
          });

        renderLayers();
      }
    }
  } catch (error) {
    console.error('Error loading town data at startup:', error);
  }
}

function processMarkers(layer) {
  const markers = layer.markers;

  const processed = [];
  const nationData = {};
  let minDate = Infinity;
  let maxDate = -Infinity;

  markers.forEach(marker => {
    if (marker.type === 'polygon' && marker.popup) {
      const popupData = extractPopup(marker.popup);
      if (popupData) {
        const latlngs = transformPoints(marker.points);
        // Filter out empty strings if any
        const residents = popupData.residents.filter(r => r.trim().length > 0);
        const pop = residents.length;
        const area = calculatePolygonArea(marker.points) / 256;

        if (popupData.nation) {
          if (!nationData[popupData.nation]) {
            nationData[popupData.nation] = {
              "population": 0,
              "claims": 0,
              "towns": 0
            }
          }
          nationData[popupData.nation]["population"] += pop;
          nationData[popupData.nation]["claims"] += area;
          nationData[popupData.nation]["towns"] += 1;
        }

        const dateStr = popupData.founded;
        const dateTs = Date.parse(dateStr);
        if (!Number.isNaN(dateTs)) {
          if (dateTs < minDate) minDate = dateTs;
          if (dateTs > maxDate) maxDate = dateTs;
        }

        processed.push({
          marker,
          popupData,
          latlngs,
          pop,
          area,
          foundedTs: Number.isNaN(dateTs) ? null : dateTs
        });
      }
    }
  });

  minDateGlobal = minDate;
  maxDateGlobal = maxDate;

  // Store processed data for re-rendering
  processedMarkersData = processed.map(item => {
    let nationPop = 0;
    let nationClaims = 0;
    let nationTowns = 0;
    if (item.popupData.nation) {
      nationPop = nationData[item.popupData.nation]["population"] || 0;
      nationClaims = nationData[item.popupData.nation]["claims"] || 0;
      nationTowns = nationData[item.popupData.nation]["towns"] || 0;
    }
    return {...item, nationPop, nationClaims, nationTowns};
  });

  // Calculate rankings
  const populationRankings = calculateRankings(processedMarkersData, 'pop');
  const claimsRankings = calculateRankings(processedMarkersData, 'area');
  const nationPopRankings = calculateNationRankings(processedMarkersData, 'nationPop');
  const nationClaimsRankings = calculateNationRankings(processedMarkersData, 'nationClaims');
  const foundedGroupings = calculateFoundedGroupings(processedMarkersData, minDateGlobal, maxDateGlobal);

  // Attach rankings to each item
  processedMarkersData.forEach(item => {
    item.populationRank = populationRankings[item.popupData.name];
    item.claimsRank = claimsRankings[item.popupData.name];
    item.nationPopRank = nationPopRankings[item.popupData.nation] || null;
    item.nationClaimsRank = nationClaimsRankings[item.popupData.nation] || null;
    item.foundedGrouping = foundedGroupings[item.popupData.name];
  });

  // Attach the array to the global window so the inline onclick can access it
  globalThis.processedMarkersData = processedMarkersData;

  renderLayers();
}

function getNationBonus(nationPop) {
  if (nationPop >= 200) return 100;
  if (nationPop >= 120) return 80;
  if (nationPop >= 80) return 60;
  if (nationPop >= 60) return 50;
  if (nationPop >= 40) return 30;
  if (nationPop >= 20) return 10;
  return 0;
}

// Ensure Turf.js is loaded
function loadTurf() {
  return new Promise((resolve, reject) => {
    if (globalThis.turf) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/@turf/turf@6/turf.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Turf.js'));
    document.head.appendChild(script);
  });
}

// Batch size max 100
async function fetchTownsInBatches(townNames, batchSize = 100) {
  const results = [];
  for (let i = 0; i < townNames.length; i += batchSize) {
    const batch = townNames.slice(i, i + batchSize);
    try {
      const response = await fetch(`${baseUrlApi}/towns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: batch,
          template: {
            name: true,
            coordinates: true,
            status: true,
            stats: true
          }
        })
      });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data)) {
          results.push(...data);
        }
      }
    } catch (error) {
      console.error("Error fetching town batch:", error);
    }
  }
  return results;
}

function enrichProcessedDataWithApiData(apiData) {
  if (!apiData || !Array.isArray(apiData)) return;

  // Create a map for quick lookup
  const apiMap = new Map();
  apiData.forEach(town => {
    apiMap.set(town.name, town);
  });

  // Enrich processed markers with API data
  processedMarkersData.forEach(item => {
    const apiTown = apiMap.get(item.popupData.name);
    if (apiTown) {
      item.apiData = apiTown;
      item.maxTownBlocks = apiTown.stats?.maxTownBlocks || null;
      item.hasOverclaimShield = apiTown.status?.hasOverclaimShield || false;
    }
  });
}

function drawNationRange() {
  rangeLayerGroup.clearLayers();
  if (!activeNation) return;

  // Find all towns belonging to the active nation
  const townsInNation = processedMarkersData.filter(item => item.popupData.nation === activeNation);
  const townNames = townsInNation.map(item => item.popupData.name);

  if (townNames.length === 0) return;

  // Check for cached data
  if (!allTownsDataCache) {
    // No cached data, don't draw range
    console.log('No cached town data available. Please load town data in settings.');
    return;
  }

  // Filter cached data for this nation's towns
  const data = allTownsDataCache.filter(town => townNames.includes(town.name));

  // Find the nation data to get the capital
  let capitalName = null;
  if (activeNationData?.capital?.name) {
    capitalName = activeNationData.capital.name;
  }

  loadTurf().then(async () => {
    if (!data || !Array.isArray(data) || activeNation === null) return;

    const nationColor = townsInNation.length > 0 && townsInNation[0].marker.color ? townsInNation[0].marker.color : '#3457C1';

    const polygons = [];

    data.forEach(town => {
      if (!town.coordinates?.spawn) return;
      const spawn = town.coordinates.spawn;

      const isCapital = town.name === capitalName;
      const radius = isCapital ? 5000 : 1500;

      const numSteps = 64;
      const coordinates = [];
      for (let i = 0; i < numSteps; i++) {
        const angle = (i / numSteps) * 2 * Math.PI;
        const dx = radius * Math.cos(angle);
        const dz = radius * Math.sin(angle);
        coordinates.push([spawn.x + dx, spawn.z + dz]);
      }
      coordinates.push(coordinates[0]); // Close the polygon

      polygons.push(turf.polygon([coordinates]));
    });

    if (polygons.length > 0) {
      // Union all polygons
      let mergedPolygon = polygons[0];
      for (let i = 1; i < polygons.length; i++) {
        try {
          mergedPolygon = turf.union(mergedPolygon, polygons[i]);
        } catch (e) {
          console.error("Turf union failed", e);
        }
      }

      // Convert Turf geometry back to Leaflet LatLngs
      const geojsonLayer = L.geoJSON(mergedPolygon, {
        coordsToLatLng: function (coords) {
          return new L.LatLng(coords[1], coords[0]);
        },
        style: {
          color: nationColor,
          fillColor: nationColor,
          fillOpacity: 0.1,
          weight: 2,
          dashArray: '5, 5',
          interactive: false,
        }
      });

      geojsonLayer.addTo(rangeLayerGroup);
    }
  }).catch(err => {
    console.error(err);
  });
}

function renderLayers() {
  // Clear existing layers
  Object.values(layerGroups).forEach(group => group.clearLayers());

  processedMarkersData.forEach(item => {
    // Calculate colors
    const popColor = getColor(item.pop, POPULATION_GRADIENT);
    const nationPopColor = item.popupData.nation ? getColor(item.nationPop, NATION_POPULATION_GRADIENT) : "#606060";
    const nationClaimsColor = item.popupData.nation ? getColor(item.nationClaims, NATION_CLAIMS_GRADIENT) : "#606060";
    const claimColor = getColor(item.area, CLAIMS_GRADIENT);

    const density = item.area > 0 ? item.pop / item.area : 0;
    const densityColor = getDensityColor(density);

    let foundedColor = "#000000";
    if (item.foundedTs !== null) {
      foundedColor = getDateColor(item.foundedTs, minDateGlobal, maxDateGlobal);
    }

    // Claim Limit Calculation
    let claimLimit;
    if (item.maxTownBlocks !== null && item.maxTownBlocks !== undefined) {
      claimLimit = item.maxTownBlocks;
    } else {
      const nationBonus = item.popupData.nation ? getNationBonus(item.nationPop) : 0;
      claimLimit = (item.pop * 12) + nationBonus;
    }

    const claims = Math.round(item.area);
    const diff = claimLimit - claims;

    let claimLimitColor;
    if (diff > 0 && item.hasOverclaimShield) {
      claimLimitColor = "#00A500";
    } else if (diff > 0) {
      claimLimitColor = "#00FF00";
    } else if (diff === 0 && item.hasOverclaimShield) {
      claimLimitColor = "#B7FF00";
    } else if (diff === 0) {
      claimLimitColor = "#FFFF00";
    } else if (diff < 0 && item.hasOverclaimShield) {
      claimLimitColor = "#FFA500";
    } else {
      claimLimitColor = "#FF0000";
    }

    const isOtherNation = activeNation !== null && item.popupData.nation !== activeNation;
    const greyOutColor = '#606060';

    // Create Popup Content
    const popupContent = getPopupContent(item, popColor, claimColor, densityColor, foundedColor, nationPopColor, nationClaimsColor, density, claimLimit, diff, claimLimitColor);

    if (!item.marker.color) {
      item.marker.color = "#3457C1";
    }

    // Get ranking border colors
    const populationBorderColor = getRankingBorderColor(item.populationRank);
    const claimsBorderColor = getRankingBorderColor(item.claimsRank);
    const nationPopBorderColor = getRankingBorderColor(item.nationPopRank);
    const nationClaimsBorderColor = getRankingBorderColor(item.nationClaimsRank);
    const foundedBorderColor = rankingsOutlinesEnabled ? FOUNDED_GROUPING_COLORS[item.foundedGrouping] : null;

    // Default Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: isOtherNation ? greyOutColor : item.marker.color,
      fillColor: isOtherNation ? greyOutColor : item.marker.fillColor,
      fillOpacity: isOtherNation ? 0.5 : item.marker.opacity
    }).addTo(layerGroups.default);

    // Population Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: isOtherNation ? greyOutColor : (populationBorderColor || popColor),
      fillColor: isOtherNation ? greyOutColor : popColor,
      fillOpacity: 0.5,
      weight: populationBorderColor ? 3 : item.marker.weight
    }).addTo(layerGroups.population);

    // Nation Population Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: isOtherNation ? greyOutColor : (nationPopBorderColor || nationPopColor),
      fillColor: isOtherNation ? greyOutColor : nationPopColor,
      fillOpacity: 0.5,
      weight: nationPopBorderColor ? 3 : item.marker.weight
    }).addTo(layerGroups.nationPopulation);

    // Nation Claims Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: isOtherNation ? greyOutColor : (nationClaimsBorderColor || nationClaimsColor),
      fillColor: isOtherNation ? greyOutColor : nationClaimsColor,
      fillOpacity: 0.5,
      weight: nationClaimsBorderColor ? 3 : item.marker.weight
    }).addTo(layerGroups.nationClaims);

    // Claims Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: isOtherNation ? greyOutColor : (claimsBorderColor || claimColor),
      fillColor: isOtherNation ? greyOutColor : claimColor,
      fillOpacity: 0.5,
      weight: claimsBorderColor ? 3 : item.marker.weight
    }).addTo(layerGroups.claims);

    // Claim Limit Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: isOtherNation ? greyOutColor : claimLimitColor,
      fillColor: isOtherNation ? greyOutColor : claimLimitColor,
      fillOpacity: 0.5
    }).addTo(layerGroups.claimLimit);

    // Founded Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: isOtherNation ? greyOutColor : (foundedBorderColor || foundedColor),
      fillColor: isOtherNation ? greyOutColor : foundedColor,
      fillOpacity: 0.5,
      weight: foundedBorderColor ? 3 : item.marker.weight
    }).addTo(layerGroups.founded);

    // Density Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: isOtherNation ? greyOutColor : densityColor,
      fillColor: isOtherNation ? greyOutColor : densityColor,
      fillOpacity: 0.5
    }).addTo(layerGroups.density);
  });
}

function escapeHtml(text) {
  if (typeof text !== 'string') return text;
  return text
    .replaceAll('&', "&amp;")
    .replaceAll('<', "&lt;")
    .replaceAll('>', "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll('\'', "&#039;");
}

function getPopupContent(item, popColor, claimColor, densityColor, foundedColor, nationPopColor, nationClaimsColor, density, claimLimit, diff, claimLimitColor) {
  const displayDiff = -diff;
  const diffSign = displayDiff > 0 ? '+' : '';
  const diffColor = diff > 0 ? '#00FF00' : (diff < 0 ? '#FF0000' : '#FFFF00');

  const nationNameStr = item.popupData.nation ? escapeHtml(item.popupData.nation) : '';
  const safeNationName = item.popupData.nation ? escapeHtml(item.popupData.nation).replaceAll('\'', String.raw`\'`) : '';

  const shieldStatus = item.hasOverclaimShield ? `<div class="popup-row"><span class="dr-shadow" style="font-size: 1.1em; color: #FFD700;">${t('shieldActive')}</span></div>` : '';

  // Build ranking info HTML
  let rankingInfo = '';

  // Population ranking
  if (item.populationRank && item.populationRank.rank !== 'none') {
    const rankColor = RANKING_COLORS[item.populationRank.rank];
    rankingInfo += `<div class="popup-row">${t('populationRank')}:&nbsp;<span class="dr-shadow" style="font-size: 1.1em; color:${rankColor}">Top ${item.populationRank.position}</span></div>`;
  }

  // Claims ranking
  if (item.claimsRank && item.claimsRank.rank !== 'none') {
    const rankColor = RANKING_COLORS[item.claimsRank.rank];
    rankingInfo += `<div class="popup-row">${t('claimsRank')}:&nbsp;<span class="dr-shadow" style="font-size: 1.1em; color:${rankColor}">Top ${item.claimsRank.position}</span></div>`;
  }

  // Founded grouping
  if (item.foundedGrouping && item.foundedGrouping !== 'other' && item.foundedGrouping !== 'unknown') {
    const groupColor = FOUNDED_GROUPING_COLORS[item.foundedGrouping];
    const groupLabels = {day: t('oldestDay'), week: t('oldest7Days'), month: t('oldest28Days')};
    rankingInfo += `<div class="popup-row">${t('founded')}&nbsp;<span class="dr-shadow" style="font-size: 1.1em; color:${groupColor}">${groupLabels[item.foundedGrouping]}</span></div>`;
  }

  return `
      <div class="infowindow">
        <span class="dr-shadow" style="font-size: 1.3em; font-weight: bold;">${escapeHtml(item.popupData.name)}</span><br>
        <div class="popup-row">${t('population')}: <span class="color-square" style="background-color:${popColor}"></span><span class="dr-shadow" style="font-size: 1.1em;">${item.pop}</span></div>
        <div class="popup-row">${t('claims')}: <span class="color-square" style="background-color:${claimColor}"></span><span class="dr-shadow" style="font-size: 1.1em;">${Math.round(item.area)} / ${claimLimit} [<span style="color:${diffColor}">${diffSign}${displayDiff}</span>]</span></div>
        ${shieldStatus}
        <div class="popup-row">${t('density')}: <span class="color-square" style="background-color:${densityColor}"></span><span class="dr-shadow" style="font-size: 1.1em;">${Number.parseFloat(density.toFixed(3))}</span>&nbsp;<span style="font-size: 0.75em;">${t('popChunk')}</span></div>
        <div class="popup-row">${t('founded')}: <span class="color-square" style="background-color:${foundedColor}"></span><span class="dr-shadow" style="font-size: 1.1em;">${escapeHtml(item.popupData.founded)}</span></div>
        ${rankingInfo}
        <br>
        ${item.popupData.nation ? `${t('nation')}: <b class="dr-shadow nation-link" style="font-size: 1.1em;" onclick="openNationPanel('${safeNationName}')">${nationNameStr}</b><br>` : ''}
        <div class="popup-row">${t('nationClaimsLabel')}: <span class="color-square" style="background-color:${nationClaimsColor}"></span><span class="dr-shadow" style="font-size: 1.1em;">${Math.round(item.nationClaims)}</span></div>
        <div class="popup-row">${t('nationPopLabel')}: <span class="color-square" style="background-color:${nationPopColor}"></span><span class="dr-shadow" style="font-size: 1.1em;">${item.nationPop}</span></div>
      </div>
    `;
}

function createPolygon(latlngs, marker, popupContent, style) {
  const poly = L.polygon(latlngs, {
    weight: marker.weight,
    opacity: 1,
    ...style
  });

  poly.bindPopup(popupContent);
  return poly;
}

function setupControls() {
  const controlsDiv = document.getElementById('controls');
  const modeLabel = document.getElementById('mode-label');
  if (!controlsDiv) return;

  // Clear existing controls if any
  controlsDiv.innerHTML = '';

  Object.keys(layerGroups).forEach(key => {
    const button = document.createElement('button');
    const imgUrl = new URL(`./img/${key.toLowerCase()}.png`, import.meta.url).href;
    const name = t(layerKeys[key]);
    button.innerHTML = `<div class="mmb-outline"><img src="${imgUrl}" alt="${name}" title="${name}" /></div>`
    button.className = "mapmode-button";
    button.title = name;
    if (key === currentMode) {
      button.classList.add('active');
      if (modeLabel) modeLabel.innerText = name;
    }
    button.onclick = () => {
      switchLayer(key);
      document.querySelectorAll('.mapmode-button').forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      if (modeLabel) modeLabel.innerText = t(layerKeys[key]);
      updateLegend();
    };
    controlsDiv.appendChild(button);
  });
}

function switchLayer(name) {
  currentMode = name;
  Object.values(layerGroups).forEach(group => {
    map.removeLayer(group);
  });
  if (layerGroups[name]) {
    layerGroups[name].addTo(map);
  }
}

function setupLegend() {
  const legendBtn = document.getElementById('legend-btn');
  const legendPopup = document.getElementById('legend-popup');

  if (legendBtn && legendPopup) {
    legendBtn.onclick = () => {
      if (legendPopup.style.display === 'none') {
        legendPopup.style.display = 'block';
        updateLegend();
      } else {
        legendPopup.style.display = 'none';
      }
    };
  }
}

function setupSettings() {
  const settingsBtn = document.getElementById('settings-btn');
  const settingsPopup = document.getElementById('settings-popup');
  const langSelect = document.getElementById('lang-select');
  const gridToggle = document.getElementById('grid-toggle');
  const rankingsToggle = document.getElementById('rankings-toggle');

  if (settingsBtn && settingsPopup) {
    settingsBtn.onclick = () => {
      if (settingsPopup.style.display === 'none') {
        settingsPopup.style.display = 'flex';
      } else {
        settingsPopup.style.display = 'none';
      }
    };

    // Populate languages
    if (langSelect) {
      langSelect.innerHTML = '';
      Object.keys(translations).forEach(lang => {
        const langName = translations[lang].name;
        const option = document.createElement('option');
        option.value = lang;
        option.innerText = langName;
        if (lang === currentLang) {
          option.selected = true;
        }
        langSelect.appendChild(option);
      });
      langSelect.onchange = () => {
        changeLanguage(langSelect.value);
      };
    }

    // Grid Toggle
    if (gridToggle) {
      gridToggle.onchange = (e) => {
        if (e.target.checked) {
          gridLayer.addTo(map);
        } else {
          map.removeLayer(gridLayer);
        }
      };
    }

    // Rankings Outlines Toggle
    if (rankingsToggle) {
      rankingsToggle.checked = rankingsOutlinesEnabled;
      rankingsToggle.onchange = (e) => {
        rankingsOutlinesEnabled = e.target.checked;
        localStorage.setItem('emc-mapmodes-rankings-outlines', rankingsOutlinesEnabled);
        renderLayers();
      };
    }
  }
}

function changeLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('emc-mapmodes-lang', lang);

  // Update UI
  updateUIText();
  setupControls(); // Re-render controls to update tooltips/names
  updateLegend();
  renderLayers(); // Re-render layers to update popup content

  // Update language selector value
  const langSelect = document.getElementById('lang-select');
  if (langSelect) {
    langSelect.value = lang;
  }
}

function updateUIText() {
  const legendBtn = document.getElementById('legend-btn');
  if (legendBtn) legendBtn.innerText = t('legend');

  const legendTitle = document.getElementById('legend-title');
  if (legendTitle) legendTitle.innerText = t('legend');

  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.innerText = t('settings');

  const langLabel = document.getElementById('lang-label');
  if (langLabel) langLabel.innerText = t('language');

  const gridLabel = document.getElementById('grid-label');
  if (gridLabel) gridLabel.innerText = t('chunkGrid');

  const gridText = document.getElementById('grid-text');
  if (gridText) gridText.innerText = t('chunkGrid');

  const townDataLabel = document.getElementById('town-data-label');
  if (townDataLabel) townDataLabel.innerText = t('townData');

  const rankingsLabel = document.getElementById('rankings-label');
  if (rankingsLabel) rankingsLabel.innerText = t('rankingsOutlines');

  const rankingsText = document.getElementById('rankings-text');
  if (rankingsText) rankingsText.innerText = t('rankingsOutlines');
}

function updateLegend() {
  const legendContent = document.getElementById('legend-content');
  if (!legendContent) return;

  legendContent.innerHTML = '';

  if (currentMode === 'default') {
    legendContent.innerHTML = `<div class="text-gray-400 italic">${t('noLegend')}</div>`;
    return;
  }

  if (currentMode === 'claimLimit') {
    legendContent.innerHTML = `
      <div class="flex flex-col gap-1">
      <div class="flex items-center gap-2">
          <div class="w-4 h-4 border border-white" style="background-color: #00A500"></div>
          <span>${t('underLimit')} (${t('shield')})</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="w-4 h-4 border border-white" style="background-color: #00FF00"></div>
          <span>${t('underLimit')}</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="w-4 h-4 border border-white" style="background-color: #B7FF00"></div>
          <span>${t('atLimit')} (${t('shield')})</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="w-4 h-4 border border-white" style="background-color: #FFFF00"></div>
          <span>${t('atLimit')}</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="w-4 h-4 border border-white" style="background-color: #FFA500"></div>
          <span>${t('overLimit')} (${t('shield')})</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="w-4 h-4 border border-white" style="background-color: #FF0000"></div>
          <span>${t('overLimit')}</span>
        </div>
      </div>
    `;
    return;
  }

  if (currentMode === 'founded') {
    // Gradient for dates + founded groupings
    const minDateStr = new Date(minDateGlobal).toLocaleDateString();
    const maxDateStr = new Date(maxDateGlobal).toLocaleDateString();

    legendContent.innerHTML = `
      <div class="flex flex-col gap-1">
        <div style="font-weight: bold; margin-bottom: 0.5em;">${t('valueGradient')}:</div>
        <div class="flex items-center gap-2">
          <div class="w-4 h-4 border border-white" style="background-color: hsl(240, 100%, 50%)"></div>
          <span>${t('oldest')} (${minDateStr})</span>
        </div>
        <div class="h-20 w-4 ml-0.5 my-1" style="background: linear-gradient(to bottom, rgba(0, 0, 255, 1) 0%, rgba(72, 218, 247, 1) 25%, rgba(14, 255, 10) 50%, rgba(251, 255, 0) 75%, rgba(255, 0, 0, 1) 100%)"></div>
        <div class="flex items-center gap-2">
          <div class="w-4 h-4 border border-white" style="background-color: hsl(0, 100%, 50%)"></div>
          <span>${t('newest')} (${maxDateStr})</span>
        </div>
        <div style="font-weight: bold; margin-top: 1em; margin-bottom: 0.5em;">${t('rankings')}:</div>
        <div class="flex items-center gap-2">
          <div class="w-4 h-4 border bg-gray-600" style="border-color: #FFD700; border-width: 2px;"></div>
          <span>${t('oldestDay')}</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="w-4 h-4 border bg-gray-600" style="border-color: #C0C0C0; border-width: 2px;"></div>
          <span>${t('oldest7Days')}</span>
        </div>
        <div class="flex items-center gap-2">
          <div class="w-4 h-4 border bg-gray-600" style="border-color: #CD7F32; border-width: 2px;"></div>
          <span>${t('oldest28Days')}</span>
        </div>
      </div>
    `;
    return;
  }

  if (currentMode === 'density') {
    DENSITY_STOPS.forEach((stop, index) => {
      const color = `rgb(${stop.color.r},${stop.color.g},${stop.color.b})`;
      let label = `${stop.val} ${t('popChunk')}`;

      const row = document.createElement('div');
      row.className = 'flex items-center gap-2';
      row.innerHTML = `
        <div class="w-4 h-4 border border-white" style="background-color: ${color}"></div>
        <span>${label}</span>
      `;
      legendContent.appendChild(row);
    });
    return;
  }

  let gradient = [];
  if (currentMode === 'population') gradient = POPULATION_GRADIENT;
  else if (currentMode === 'nationPopulation') gradient = NATION_POPULATION_GRADIENT;
  else if (currentMode === 'claims') gradient = CLAIMS_GRADIENT;
  else if (currentMode === 'nationClaims') gradient = NATION_CLAIMS_GRADIENT;

  if (gradient.length > 0) {
    // Add ranking legend for modes that support it
    if (['population', 'claims', 'nationPopulation', 'nationClaims'].includes(currentMode)) {
      const rankingTitle = document.createElement('div');
      rankingTitle.className = 'font-bold mb-2';
      rankingTitle.textContent = t('rankings');
      legendContent.appendChild(rankingTitle);

      const goldRow = document.createElement('div');
      goldRow.className = 'flex items-center gap-2';
      goldRow.innerHTML = `
        <div class="w-4 h-4 border-3 bg-gray-600" style="border-color: #FFD700"></div>
        <span>${t('top1')}</span>
      `;
      legendContent.appendChild(goldRow);

      const silverRow = document.createElement('div');
      silverRow.className = 'flex items-center gap-2';
      silverRow.innerHTML = `
        <div class="w-4 h-4 border-3 bg-gray-600" style="border-color: #C0C0C0"></div>
        <span>${t('top3')}</span>
      `;
      legendContent.appendChild(silverRow);

      const bronzeRow = document.createElement('div');
      bronzeRow.className = 'flex items-center gap-2';
      bronzeRow.innerHTML = `
        <div class="w-4 h-4 border-3 bg-gray-600" style="border-color: #CD7F32"></div>
        <span>${t('top10')}</span>
      `;
      legendContent.appendChild(bronzeRow);

      const spacer = document.createElement('div');
      spacer.style.height = '1em';
      legendContent.appendChild(spacer);

      const gradientTitle = document.createElement('div');
      gradientTitle.className = 'font-bold mb-2';
      gradientTitle.textContent = t('valueGradient');
      legendContent.appendChild(gradientTitle);
    }

    gradient.forEach((step, index) => {
      let label = `>= ${step.min}`;

      const row = document.createElement('div');
      row.className = 'flex items-center gap-2';
      row.innerHTML = `
        <div class="w-4 h-4 border border-white" style="background-color: ${step.color}"></div>
        <span>${label}</span>
      `;
      legendContent.appendChild(row);
    });

    const lastStep = gradient.at(-1);
    if (lastStep && lastStep.min > 1) {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2';
      row.innerHTML = `
         <div class="w-4 h-4 border border-white" style="background-color: #1F0000"></div>
         <span>< ${lastStep.min}</span>
       `;
      legendContent.appendChild(row);
    }
  }
}

/**
 * Minifies an HTML string by removing extra whitespace, newlines, and tabs.
 */
function minifyHTML(html) {
  return html
    .replaceAll(/>\s+</g, "><")
    .replaceAll("\n", "")
    .trim();
}

function extractPopup(popup) {
  // Big scary regex monster
  const popupRegex = /<div class="infowindow"><span .+?>(?:<a href=.+?>|)(.+?)(?:<\/a>|)(?: \((?:<a href=.+?>|)(.+?)(?:<\/a>|)\)|)<\/span><br><i>(.+?|)<\/i>.+?Mayor: <b>(.+?)<\/b>.+?Councillors: <b>(.+?)<\/b>.+?Founded: <b>(.+?)<\/b>.+?PVP: <b>(.+?)<\/b>.+?Public: <b>(.+?)<\/b>.+?<\/summary>(.+?)<\/details>.+?<\/div>/;

  popup = minifyHTML(popup);
  let matches = popup.match(popupRegex);

  if (!matches) return null;

  return {
    name: matches[1],
    nation: matches[2],
    board: matches[3],
    mayor: matches[4],
    councillors: matches[5],
    founded: matches[6],
    pvp: matches[7],
    public: matches[8],
    residents: matches[9].trim().split(','),
  }
}

function transformPoints(points) {
  if (!Array.isArray(points)) return [];
  if (points.length > 0 && points[0] && typeof points[0].x === 'number' && typeof points[0].z === 'number') {
    return points.map(p => [p.z, p.x]);
  }
  return points.map(transformPoints);
}

function calculatePolygonArea(points) {
  if (!Array.isArray(points)) return 0;
  if (points.length === 0) return 0;

  if (points[0] && typeof points[0].x === 'number' && typeof points[0].z === 'number') {
    const x = points.map(p => p.x);
    const y = points.map(p => p.z);
    return calcArea(x, y, points.length);
  }

  return points.reduce((sum, part) => sum + calculatePolygonArea(part), 0);
}

/**
 * Calculate area of polygon.
 * @function calcArea
 * @param {Array} x Array of X coordinates
 * @param {Array} y Array of Y coordinates
 * @param {number} ptsNum Amount of coordinate points
 * @returns {number} Calculated area
 */
function calcArea(x, y, ptsNum) {
  let area = 0;
  let j = ptsNum - 1;

  for (let i = 0; i < ptsNum; i++) {
    area = area + (x[j] + x[i]) * (y[j] - y[i]);
    j = i;
  }

  return Math.abs(area / 2);
}

async function fetchNationData(nationName) {
  try {
    const response = await fetch(`${baseUrlApi}/nations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: [nationName],
        template: {
          name: true,
          board: true,
          king: true,
          capital: true,
          timestamps: true
        }
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data && data.length > 0 ? data[0] : null;
  } catch (error) {
    console.error("Error fetching nation data:", error);
    return null;
  }
}

// Global functions for Nation Panel
globalThis.openNationPanel = async function (nationName) {
  const panel = document.getElementById("nation-panel");
  const content = document.getElementById("nation-panel-content");

  if (panel) {
    panel.classList.add("open");
  }

  // Clear range layer
  rangeLayerGroup.clearLayers();

  if (activeNation !== nationName) {
    activeNation = nationName;
    renderLayers();
  }

  if (content && globalThis.processedMarkersData) {
    // Find nation data from map
    const nationItem = globalThis.processedMarkersData.find(item => item.popupData.nation === nationName);

    // Show a loading state while fetching API data
    content.innerHTML = `
      <div class="nation-panel-title dr-shadow" style="color: ${nationItem ? nationItem.marker.color : '#3457C1'}">${escapeHtml(nationName)}</div>
      <div class="text-gray-400 my-4 text-center">${t('loading')}</div>
    `;

    // Fetch API data
    const apiData = await fetchNationData(nationName);
    activeNationData = apiData;

    // Draw the range after getting the API data (to know capital)
    drawNationRange();

    if (nationItem) {
      const popColor = getColor(nationItem.nationPop, NATION_POPULATION_GRADIENT);
      const claimsColor = getColor(nationItem.nationClaims, NATION_CLAIMS_GRADIENT);

      let apiContent = '';
      if (apiData) {
        const foundedDate = apiData.timestamps?.registered ? new Date(apiData.timestamps.registered).toLocaleDateString() : 'Unknown';

        apiContent = `
          <div class="nation-panel-stat mt-4 pt-4 border-t border-gray-700">
            <span style="color: #aaa">${t('nationLeader')}:</span> 
            <span class="dr-shadow">${apiData.king?.name ? escapeHtml(apiData.king.name) : 'None'}</span>
          </div>
          <div class="nation-panel-stat">
            <span style="color: #aaa">${t('nationCapital')}:</span> 
            <span class="dr-shadow">${apiData.capital?.name ? escapeHtml(apiData.capital.name) : 'None'}</span>
          </div>
          <div class="nation-panel-stat">
            <span style="color: #aaa">${t('founded')}:</span> 
            <span class="dr-shadow">${foundedDate}</span>
          </div>
          ${apiData.board ? `
            <div class="mt-4 p-3 bg-gray-800 rounded border border-gray-700">
              <span style="color: #aaa; display:block; margin-bottom:4px; font-size: 0.9em;">${t('board')}:</span>
              <span class="italic text-gray-300">${escapeHtml(apiData.board)}</span>
            </div>
          ` : ''}
        `;
      } else {
        apiContent = `
           <div class="mt-4 pt-4 border-t border-gray-700 text-gray-500 italic text-sm">
             ${t('error')}
           </div>
         `;
      }

      content.innerHTML = `
        <div class="nation-panel-title dr-shadow">${escapeHtml(nationName)}</div>
        <div class="nation-panel-stat">
          <span style="color: #aaa">${t('nationPopLabel')}:</span> 
          <span class="color-square" style="background-color:${popColor}"></span>
          <span class="dr-shadow">${nationItem.nationPop}</span>
        </div>
        <div class="nation-panel-stat">
          <span style="color: #aaa">${t('nationClaimsLabel')}:</span> 
          <span class="color-square" style="background-color:${claimsColor}"></span>
          <span class="dr-shadow">${Math.round(nationItem.nationClaims)}</span>
        </div>
        <div class="nation-panel-stat">
          <span style="color: #aaa">${t('nationTownsLabel')}:</span> 
          <span class="dr-shadow">${nationItem.nationTowns || 0}</span>
        </div>
        ${apiContent}
      `;
    } else {
      content.innerHTML = `<div class="nation-panel-title dr-shadow">${escapeHtml(nationName)}</div><p>${t('error')}</p>`;
    }
  }
}

globalThis.closeNav = function () {
  const panel = document.getElementById("nation-panel");
  if (panel) {
    panel.classList.remove("open");
  }

  rangeLayerGroup.clearLayers();

  if (activeNation !== null) {
    activeNation = null;
    activeNationData = null;
    renderLayers();
  }
}
