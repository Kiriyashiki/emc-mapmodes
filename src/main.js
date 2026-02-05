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

// Configuration
const baseUrl = 'https://map.earthmc.net/tiles/minecraft_overworld';
const baseUrlCors = `https://feur.hainaut.xyz/proxy?url=${baseUrl}`;
const maxNativeZoom = 3;
const maxZoom = 4;
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
    [-16666, -33333],
    [16510, 33083],
  ]
});

L.tileLayer(`${baseUrl}/{z}/{x}_{y}.png`, {
  tileSize: tileSize,
  minZoom: minZoom,
  maxZoom: maxZoom,
  maxNativeZoom: maxNativeZoom,
  noWrap: true,
  attribution: 'Map Data <a href="https://map.earthmc.net/">EMC</a>'
}).addTo(map);

// Layer Groups
const layerGroups = {
  default: L.layerGroup(),
  population: L.layerGroup(),
  claims: L.layerGroup(),
  nationPopulation: L.layerGroup(),
  nationClaims: L.layerGroup(),
  founded: L.layerGroup(),
  density: L.layerGroup()
};

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
  nationPopulation: "nationPopulation",
  nationClaims: "nationClaims",
  founded: "founded",
  density: "density"
};

let currentMode = 'default';
let minDateGlobal = Infinity;
let maxDateGlobal = -Infinity;
let processedMarkersData = []; // Store processed data to re-render popups on language change

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

// Add default layer to map initially
layerGroups.default.addTo(map);

// Fetch and display markers
fetchMarkers()
  .then(data => {
    let layer;
    for (let l of data) {
      if (l.id === "towny") {
        layer = l;
        break;
      }
    }
    processMarkers(layer);
    setupControls();
    setupLegend();
    setupLanguageSelector();
    updateUIText();
  })
  .catch(error => console.error('Error loading markers:', error));

function fetchMarkers() {
  return fetch(`${baseUrlCors}/markers.json`)
    .then(response => response.json());
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
              "claims": 0
            }
          }
          nationData[popupData.nation]["population"] += pop;
          nationData[popupData.nation]["claims"] += area;
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
    if (item.popupData.nation) {
      nationPop = nationData[item.popupData.nation]["population"] || 0;
      nationClaims = nationData[item.popupData.nation]["claims"] || 0;
    }
    return {...item, nationPop, nationClaims};
  });

  renderLayers();
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

    // Create Popup Content
    const popupContent = getPopupContent(item, popColor, claimColor, densityColor, foundedColor, nationPopColor, nationClaimsColor, density);

    // Default Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: item.marker.color,
      fillColor: item.marker.fillColor,
      fillOpacity: item.marker.opacity
    }).addTo(layerGroups.default);

    // Population Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: popColor,
      fillColor: popColor,
      fillOpacity: 0.5
    }).addTo(layerGroups.population);

    // Nation Population Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: nationPopColor,
      fillColor: nationPopColor,
      fillOpacity: 0.5
    }).addTo(layerGroups.nationPopulation);

    // Nation Claims Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: nationClaimsColor,
      fillColor: nationClaimsColor,
      fillOpacity: 0.5
    }).addTo(layerGroups.nationClaims);

    // Claims Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: claimColor,
      fillColor: claimColor,
      fillOpacity: 0.5
    }).addTo(layerGroups.claims);

    // Founded Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: foundedColor,
      fillColor: foundedColor,
      fillOpacity: 0.5
    }).addTo(layerGroups.founded);

    // Density Layer
    createPolygon(item.latlngs, item.marker, popupContent, {
      color: densityColor,
      fillColor: densityColor,
      fillOpacity: 0.5
    }).addTo(layerGroups.density);
  });
}

function getPopupContent(item, popColor, claimColor, densityColor, foundedColor, nationPopColor, nationClaimsColor, density) {
  return `
      <div class="infowindow">
        <span class="dr-shadow" style="font-size: 1.3em; font-weight: bold;">${item.popupData.name}</span><br>
        <div class="popup-row">${t('population')}: <span class="color-square" style="background-color:${popColor}"></span><span class="dr-shadow" style="font-size: 1.1em;">${item.pop}</span></div>
        <div class="popup-row">${t('claims')}: <span class="color-square" style="background-color:${claimColor}"></span><span class="dr-shadow" style="font-size: 1.1em;">${Math.round(item.area)}</span></div>
        <div class="popup-row">${t('density')}: <span class="color-square" style="background-color:${densityColor}"></span><span class="dr-shadow" style="font-size: 1.1em;">${Number.parseFloat(density.toFixed(3))}</span>&nbsp;<span style="font-size: 0.75em;">${t('popChunk')}</span></div>
        <div class="popup-row">${t('founded')}: <span class="color-square" style="background-color:${foundedColor}"></span><span class="dr-shadow" style="font-size: 1.1em;">${item.popupData.founded}</span></div>
        <br>
        ${item.popupData.nation ? `${t('nation')}: <b class="dr-shadow" style="font-size: 1.1em;">${item.popupData.nation}</b><br>` : ''}
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
    const button = document.createElement('div');
    const imgUrl = new URL(`./img/${key.toLowerCase()}.png`, import.meta.url).href;
    const name = t(layerKeys[key]);
    button.innerHTML = `<div class="mmb-outline"><img src="${imgUrl}" alt="${name}" title="${name}" /></div>`
    button.className = "mapmode-button";
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

function setupLanguageSelector() {
  const langBtn = document.getElementById('lang-btn');
  const langPopup = document.getElementById('lang-popup');

  if (langBtn && langPopup) {
    langBtn.onclick = () => {
      if (langPopup.style.display === 'none') {
        langPopup.style.display = 'flex';
      } else {
        langPopup.style.display = 'none';
      }
    };

    // Populate languages
    Object.keys(translations).forEach(lang => {
      const langName = translations[lang].name;
      const btn = document.createElement('button');
      btn.className = "text-left px-2 py-1 hover:bg-gray-700 rounded w-full";
      btn.innerText = langName;
      if (lang === currentLang) {
        btn.classList.add('font-bold');
      }
      btn.onclick = () => {
        changeLanguage(lang);
        langPopup.style.display = 'none';
      };
      langPopup.appendChild(btn);
    });
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

  // Update language selector active state
  const langPopup = document.getElementById('lang-popup');
  if (langPopup) {
    Array.from(langPopup.children).forEach(btn => {
      if (btn.innerText === lang.toUpperCase()) {
        btn.classList.add('font-bold');
      } else {
        btn.classList.remove('font-bold');
      }
    });
  }
}

function updateUIText() {
  const legendBtn = document.getElementById('legend-btn');
  if (legendBtn) legendBtn.innerText = t('legend');

  const legendTitle = document.getElementById('legend-title');
  if (legendTitle) legendTitle.innerText = t('legend');

  const langBtn = document.getElementById('lang-btn');
  if (langBtn) langBtn.innerText = t('language');

  const modeLabel = document.getElementById('mode-label');
  if (modeLabel) modeLabel.innerText = t(layerKeys[currentMode]);
}

function updateLegend() {
  const legendContent = document.getElementById('legend-content');
  if (!legendContent) return;

  legendContent.innerHTML = '';

  if (currentMode === 'default') {
    legendContent.innerHTML = `<div class="text-gray-400 italic">${t('noLegend')}</div>`;
    return;
  }

  if (currentMode === 'founded') {
    // Gradient for dates
    const minDateStr = new Date(minDateGlobal).toLocaleDateString();
    const maxDateStr = new Date(maxDateGlobal).toLocaleDateString();

    legendContent.innerHTML = `
      <div class="flex flex-col gap-1">
        <div class="flex items-center gap-2">
          <div class="w-4 h-4 border border-white" style="background-color: hsl(240, 100%, 50%)"></div>
          <span>${t('oldest')} (${minDateStr})</span>
        </div>
        <div class="h-20 w-4 ml-0.5 my-1" style="background: linear-gradient(to bottom, rgba(0, 0, 255, 1) 0%, rgba(72, 218, 247, 1) 25%, rgba(14, 255, 10, 1) 50%, rgba(251, 255, 0, 1) 75%, rgba(255, 0, 0, 1) 100%)"></div>
        <div class="flex items-center gap-2">
          <div class="w-4 h-4 border border-white" style="background-color: hsl(0, 100%, 50%)"></div>
          <span>${t('newest')} (${maxDateStr})</span>
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
