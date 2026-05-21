/**
 * IoT Parking Prediction System - App Engine
 * Kampus Parkir Smart Monitor
 */

// ─── Global State ───────────────────────────────────────────
const APP = {
  parkingData: null,
  predictions: null,
  currentHour: new Date().getHours(),
  selectedPredDay: 0,
  charts: {},
  sensorInterval: null,
  clockInterval: null,
};

// ─── Color helpers ──────────────────────────────────────────
const STATUS = {
  getStatus(rate) {
    if (rate < 0.5)  return { code: 'available', label: 'Tersedia',      color: '#10b981', class: 'badge-available' };
    if (rate < 0.75) return { code: 'moderate',  label: 'Sedang',        color: '#f59e0b', class: 'badge-moderate' };
    if (rate < 0.90) return { code: 'busy',      label: 'Hampir Penuh',  color: '#f43f5e', class: 'badge-busy' };
    return               { code: 'full',      label: 'Penuh',         color: '#8b5cf6', class: 'badge-full' };
  },
  fillClass(rate) {
    if (rate < 0.5)  return 'zone-fill-available';
    if (rate < 0.75) return 'zone-fill-moderate';
    if (rate < 0.90) return 'zone-fill-busy';
    return               'zone-fill-full';
  },
  slotClass(rate) {
    if (rate < 0.5)  return 'status-available';
    if (rate < 0.75) return 'status-moderate';
    if (rate < 0.90) return 'status-busy';
    return               'status-full';
  }
};

// ─── Formatting ─────────────────────────────────────────────
function fmtHour(h) { return `${String(h).padStart(2,'0')}:00`; }
function fmtPct(r)  { return `${Math.round(r * 100)}%`; }
function fmtNum(n)  { return n.toLocaleString('id-ID'); }

// ─── Data Loader ────────────────────────────────────────────
async function loadData() {
  try {
    const [parkRes, predRes] = await Promise.all([
      fetch('data/parking_data.json'),
      fetch('data/predictions.json'),
    ]);
    APP.parkingData  = await parkRes.json();
    APP.predictions  = await predRes.json();
    return true;
  } catch (e) {
    console.warn('Using demo data (JSON files not found):', e.message);
    APP.parkingData  = generateDemoData();
    APP.predictions  = generateDemoPredictions();
    return false;
  }
}

// ─── Demo Data (fallback) ────────────────────────────────────
function generateDemoData() {
  const config = {
    kampus: "Universitas Teknologi Nusantara",
    total_slot: 300,
    zona: {
      A: { nama: "Zona A - Motor Mahasiswa", kapasitas: 120, tipe: "motor" },
      B: { nama: "Zona B - Mobil Dosen",     kapasitas: 80,  tipe: "mobil" },
      C: { nama: "Zona C - Motor Umum",       kapasitas: 60,  tipe: "motor" },
      D: { nama: "Zona D - Mobil Tamu",       kapasitas: 40,  tipe: "mobil" },
    }
  };

  const BASELINE = { 6:0.05,7:0.15,8:0.55,9:0.85,10:0.90,11:0.88,12:0.75,13:0.80,14:0.85,15:0.82,16:0.65,17:0.45,18:0.30,19:0.20,20:0.12,21:0.08 };
  const DAY_FACTOR = [1.0,0.95,1.0,0.92,0.88,0.35,0.15];

  const today = new Date();
  const daily_data = [];

  for (let d = -30; d <= 7; d++) {
    const date = new Date(today);
    date.setDate(today.getDate() + d);
    const wd = date.getDay() === 0 ? 6 : date.getDay() - 1;
    const isFuture = d > 0;

    const hourly = {};
    for (let h = 6; h < 22; h++) {
      const base = (BASELINE[h] || 0.1) * DAY_FACTOR[wd];
      const rate = Math.max(0, Math.min(1, base + (Math.random() - 0.5) * 0.1));
      const total_slot = config.total_slot;
      const total_terisi = Math.round(rate * total_slot);

      const zona = {};
      let remaining = total_terisi;
      Object.entries(config.zona).forEach(([id, z]) => {
        const zRate = Math.max(0, Math.min(1, rate + (Math.random()-0.5)*0.15));
        const terisi = Math.min(z.kapasitas, Math.round(zRate * z.kapasitas));
        zona[id] = { terisi, tersedia: z.kapasitas - terisi, kapasitas: z.kapasitas, occupancy_rate: terisi/z.kapasitas };
      });

      hourly[h] = { total_occupancy_rate: rate, total_terisi, total_tersedia: total_slot - total_terisi, zona };
    }

    daily_data.push({
      date: date.toISOString().split('T')[0],
      weekday: wd,
      weekday_name: ["Senin","Selasa","Rabu","Kamis","Jumat","Sabtu","Minggu"][wd],
      is_weekend: wd >= 5,
      is_future: isFuture,
      hourly
    });
  }

  return { config, daily_data, meta: { total_sensor_events: 4782691, labeled_events: 109481, unique_activities: 41, files_processed: 18 }, statistics: { avg_occupancy_rate: 0.474, busiest_hour: 11 } };
}

function generateDemoPredictions() {
  const config = generateDemoData().config;
  const BASELINE = { 6:0.05,7:0.15,8:0.55,9:0.85,10:0.90,11:0.88,12:0.75,13:0.80,14:0.85,15:0.82,16:0.65,17:0.45,18:0.30,19:0.20,20:0.12,21:0.08 };
  const DAY_FACTOR = [1.0,0.95,1.0,0.92,0.88,0.35,0.15];
  const today = new Date();
  const predictions = [];

  for (let d = 1; d <= 7; d++) {
    const date = new Date(today);
    date.setDate(today.getDate() + d);
    const wd = date.getDay() === 0 ? 6 : date.getDay() - 1;
    const hourly_predictions = {};

    for (let h = 6; h < 22; h++) {
      const rate = (BASELINE[h] || 0.1) * DAY_FACTOR[wd];
      const s = rate < 0.5 ? {status:'Tersedia Banyak',code:'available',rec:'Waktu terbaik untuk parkir'}
              : rate < 0.75 ? {status:'Sedang',code:'moderate',rec:'Masih ada slot tersedia'}
              : rate < 0.9 ? {status:'Hampir Penuh',code:'busy',rec:'Disarankan datang lebih awal'}
              : {status:'Penuh',code:'full',rec:'Cari zona parkir alternatif'};

      hourly_predictions[h] = { predicted_occupancy_rate: rate, predicted_available: Math.round((1-rate)*config.total_slot), confidence_lower: Math.max(0,rate-0.1), confidence_upper: Math.min(1,rate+0.1), ...s, status_code: s.code, recommendation: s.rec };
    }

    predictions.push({
      date: date.toISOString().split('T')[0],
      weekday_name: ["Senin","Selasa","Rabu","Kamis","Jumat","Sabtu","Minggu"][wd],
      is_weekend: wd >= 5,
      hourly_predictions,
      best_parking_hour: 6,
      worst_parking_hour: 10
    });
  }

  return { config, predictions, meta: { model: 'Temporal Pattern Regression' } };
}

// ─── Clock ──────────────────────────────────────────────────
function startClock() {
  const update = () => {
    const now = new Date();
    document.querySelectorAll('.js-clock').forEach(el => {
      el.textContent = now.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    });
    document.querySelectorAll('.js-date').forEach(el => {
      el.textContent = now.toLocaleDateString('id-ID', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    });
  };
  update();
  APP.clockInterval = setInterval(update, 1000);
}

// ─── Get current hour data ──────────────────────────────────
function getTodayData() {
  if (!APP.parkingData) return null;
  const today = new Date().toISOString().split('T')[0];
  return APP.parkingData.daily_data.find(d => d.date === today)
      || APP.parkingData.daily_data.find(d => !d.is_future);
}

function getHourData(dayData, hour) {
  const h = hour ?? APP.currentHour;
  const safeH = Math.min(Math.max(h, 6), 21);
  return dayData?.hourly?.[safeH] ?? dayData?.hourly?.['10'] ?? null;
}

// ─── Sensor Feed Simulation ──────────────────────────────────
const SENSOR_NAMES = [
  'Sensor Pintu A1','Sensor Pintu A2','Sensor B Masuk','Sensor B Keluar',
  'Sensor C1','Sensor D Tamu','Sensor Pejalan Kaki','Kamera Area A',
  'Ultrasonik Slot A12','Ultrasonik Slot B5','RFID Gate Utama','RFID Gate Samping',
];

const SENSOR_ACTIVITIES = [
  { name: 'Kendaraan Masuk', type: 'enter', detail: 'Kendaraan terdeteksi memasuki area parkir' },
  { name: 'Kendaraan Keluar', type: 'exit',  detail: 'Kendaraan keluar dari area parkir' },
  { name: 'Slot Terisi',     type: 'sensor', detail: 'Sensor ultrasonik mendeteksi slot terisi' },
  { name: 'Slot Kosong',     type: 'sensor', detail: 'Sensor ultrasonik mendeteksi slot kosong' },
  { name: 'RFID Scan',       type: 'sensor', detail: 'Kartu RFID mahasiswa terscanning' },
];

function generateSensorEvent() {
  const now = new Date();
  const sensor = SENSOR_NAMES[Math.floor(Math.random() * SENSOR_NAMES.length)];
  const activity = SENSOR_ACTIVITIES[Math.floor(Math.random() * SENSOR_ACTIVITIES.length)];
  const zones = ['A', 'B', 'C', 'D'];
  const zone = zones[Math.floor(Math.random() * zones.length)];

  return {
    time: now.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit' }),
    sensor,
    activity: activity.name,
    type: activity.type,
    detail: activity.detail + ` (Zona ${zone})`,
    zone
  };
}

function addSensorEventToFeed(feedEl, event) {
  const item = document.createElement('div');
  item.className = 'sensor-event';
  item.innerHTML = `
    <span class="sensor-dot ${event.type}"></span>
    <span class="sensor-time">${event.time}</span>
    <div class="sensor-info">
      <div class="sensor-name">${event.sensor}</div>
      <div class="sensor-detail">${event.detail}</div>
    </div>
    <span class="sensor-status status-badge ${event.type === 'enter' ? 'badge-available' : event.type === 'exit' ? 'badge-busy' : 'badge-moderate'}">${event.activity}</span>
  `;
  feedEl.insertBefore(item, feedEl.firstChild);
  if (feedEl.children.length > 30) feedEl.removeChild(feedEl.lastChild);
}

function startSensorFeed(feedEl) {
  // Initial events
  for (let i = 0; i < 8; i++) {
    setTimeout(() => addSensorEventToFeed(feedEl, generateSensorEvent()), i * 100);
  }
  APP.sensorInterval = setInterval(() => {
    if (Math.random() > 0.4) addSensorEventToFeed(feedEl, generateSensorEvent());
  }, 2500);
}

// ─── Render Zone Cards ───────────────────────────────────────
function renderZoneCards(container, hourData) {
  if (!hourData || !APP.parkingData) return;
  const config = APP.parkingData.config || APP.predictions?.config;
  container.innerHTML = '';

  Object.entries(hourData.zona).forEach(([id, data]) => {
    const rate = data.occupancy_rate;
    const status = STATUS.getStatus(rate);
    const fillCls = STATUS.fillClass(rate);
    const slotCls = STATUS.slotClass(rate);
    const zonaCfg = config?.zona?.[id] || { nama: `Zona ${id}`, tipe: 'motor' };

    const card = document.createElement('div');
    card.className = 'zone-card';
    card.innerHTML = `
      <div class="zone-header">
        <div>
          <div class="zone-name">${zonaCfg.nama}</div>
        </div>
        <div class="flex" style="gap:8px;align-items:center;">
          <span class="zone-type-badge">${zonaCfg.tipe === 'motor' ? '🏍️ Motor' : '🚗 Mobil'}</span>
          <span class="status-badge ${status.class}">${status.label}</span>
        </div>
      </div>
      <div class="zone-gauge">
        <div class="gauge-bar">
          <div class="gauge-fill ${fillCls}" style="width:${Math.round(rate*100)}%"></div>
        </div>
      </div>
      <div class="zone-numbers">
        <div>
          <div class="zone-available ${slotCls}">${data.tersedia}</div>
          <div class="zone-capacity">slot tersedia dari ${data.kapasitas}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-family:var(--font-display);font-size:1.5rem;font-weight:800;color:rgba(255,255,255,0.7)">${Math.round(rate*100)}%</div>
          <div class="text-muted text-xs">terisi</div>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

// ─── Render Progress Ring ────────────────────────────────────
function renderProgressRing(svgEl, labelEl, rate, color) {
  const r = 70, cx = 80, cy = 80;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - rate);

  const track = svgEl.querySelector('.progress-ring-track');
  const fill  = svgEl.querySelector('.progress-ring-fill');

  track.setAttribute('r', r);
  track.setAttribute('cx', cx);
  track.setAttribute('cy', cy);
  track.setAttribute('stroke-width', '12');

  fill.setAttribute('r', r);
  fill.setAttribute('cx', cx);
  fill.setAttribute('cy', cy);
  fill.setAttribute('stroke-width', '12');
  fill.setAttribute('stroke', color);
  fill.setAttribute('stroke-dasharray', circumference);
  fill.setAttribute('stroke-dashoffset', circumference); // start

  setTimeout(() => {
    fill.setAttribute('stroke-dashoffset', offset);
  }, 100);

  if (labelEl) {
    labelEl.innerHTML = `
      <div class="big-number">${Math.round(rate*100)}<span style="font-size:0.4em;opacity:0.6">%</span></div>
      <div class="text-muted text-sm">Terisi</div>
    `;
  }
}

// ─── Build Heatmap ───────────────────────────────────────────
function buildHeatmap(container) {
  if (!APP.parkingData) return;

  const history = APP.parkingData.daily_data.filter(d => !d.is_future).slice(-14);
  const hours = Array.from({length:16}, (_,i) => i + 6); // 6-21

  container.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'heatmap-grid';
  grid.style.gridTemplateColumns = `60px repeat(${hours.length}, 1fr)`;

  // Header row - hours
  const emptyCell = document.createElement('div');
  emptyCell.style.cssText = 'font-size:0.7rem;color:rgba(255,255,255,0.3);display:flex;align-items:flex-end;padding-bottom:4px;';
  grid.appendChild(emptyCell);

  hours.forEach(h => {
    const cell = document.createElement('div');
    cell.style.cssText = 'font-size:0.65rem;color:rgba(255,255,255,0.35);text-align:center;padding-bottom:4px;';
    cell.textContent = `${h}`;
    grid.appendChild(cell);
  });

  // Data rows
  history.forEach(day => {
    const label = document.createElement('div');
    label.style.cssText = 'font-size:0.68rem;color:rgba(255,255,255,0.5);display:flex;align-items:center;padding-right:8px;';
    label.textContent = day.weekday_name.slice(0, 3);
    grid.appendChild(label);

    hours.forEach(h => {
      const hData = day.hourly?.[h];
      const rate = hData?.total_occupancy_rate ?? 0;
      const pct = Math.round(rate * 100);

      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';

      // Color: low=blue, mid=yellow, high=red
      const r = Math.round(rate * 244);
      const g = Math.round((1 - Math.abs(rate - 0.5) * 2) * 160);
      const b = Math.round((1 - rate) * 240);
      cell.style.background = `rgb(${r},${g},${b})`;
      cell.style.opacity = rate < 0.05 ? '0.2' : '1';

      const tip = document.createElement('div');
      tip.className = 'heatmap-tooltip';
      tip.innerHTML = `${day.weekday_name} ${fmtHour(h)}<br>${pct}% terisi`;
      cell.appendChild(tip);

      grid.appendChild(cell);
    });
  });

  container.appendChild(grid);

  // Legend
  const legend = document.createElement('div');
  legend.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:12px;font-size:0.72rem;color:rgba(255,255,255,0.45);justify-content:flex-end;';
  legend.innerHTML = `
    <span>Kosong</span>
    <div style="display:flex;gap:2px;">
      ${[0,0.25,0.5,0.75,1].map(v => {
        const r = Math.round(v * 244);
        const g = Math.round((1 - Math.abs(v - 0.5) * 2) * 160);
        const b = Math.round((1 - v) * 240);
        return `<div style="width:20px;height:12px;border-radius:2px;background:rgb(${r},${g},${b})"></div>`;
      }).join('')}
    </div>
    <span>Penuh</span>
  `;
  container.appendChild(legend);
}

// ─── Daily Trend Chart ───────────────────────────────────────
function buildTrendChart(canvasId, dayData, label) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  if (APP.charts[canvasId]) { APP.charts[canvasId].destroy(); }

  const hours = Array.from({length:16}, (_,i) => i + 6);
  const rates = hours.map(h => Math.round((dayData?.hourly?.[h]?.total_occupancy_rate ?? 0) * 100));
  const available = hours.map(h => dayData?.hourly?.[h]?.total_tersedia ?? 0);

  APP.charts[canvasId] = new Chart(canvas, {
    type: 'line',
    data: {
      labels: hours.map(fmtHour),
      datasets: [{
        label: 'Tingkat Hunian (%)',
        data: rates,
        borderColor: '#7c6cf8',
        backgroundColor: 'rgba(124,108,248,0.15)',
        borderWidth: 2.5,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#7c6cf8',
        pointRadius: 4,
        pointHoverRadius: 7,
      },{
        label: 'Slot Tersedia',
        data: available,
        borderColor: '#10b981',
        backgroundColor: 'rgba(16,185,129,0.08)',
        borderWidth: 2,
        fill: false,
        tension: 0.4,
        pointBackgroundColor: '#10b981',
        pointRadius: 3,
        yAxisID: 'y2',
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { labels: { color:'rgba(255,255,255,0.65)', font:{size:12}, boxWidth:12 }},
        tooltip: {
          backgroundColor:'rgba(10,6,24,0.95)',
          borderColor:'rgba(255,255,255,0.1)',
          borderWidth:1,
          titleColor:'white',
          bodyColor:'rgba(255,255,255,0.7)',
          padding:12,
        }
      },
      scales: {
        x: { ticks:{color:'rgba(255,255,255,0.4)',font:{size:11}}, grid:{color:'rgba(255,255,255,0.05)'} },
        y: { ticks:{color:'rgba(255,255,255,0.4)',font:{size:11},callback:v=>`${v}%`}, grid:{color:'rgba(255,255,255,0.05)'}, min:0, max:100 },
        y2: { position:'right', ticks:{color:'rgba(16,185,129,0.6)',font:{size:11}}, grid:{display:false} }
      }
    }
  });
}

// ─── Weekly Overview Chart ───────────────────────────────────
function buildWeeklyChart(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !APP.parkingData) return;
  if (APP.charts[canvasId]) APP.charts[canvasId].destroy();

  const days = ['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'];
  const avgByDay = Array(7).fill(0).map((_, wd) => {
    const dayDatas = APP.parkingData.daily_data.filter(d => d.weekday === wd && !d.is_future);
    if (!dayDatas.length) return 0;
    const allRates = dayDatas.flatMap(d => Object.values(d.hourly).map(h => h.total_occupancy_rate));
    return Math.round((allRates.reduce((a,b) => a+b, 0) / allRates.length) * 100);
  });

  APP.charts[canvasId] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: days,
      datasets: [{
        label: 'Rata-rata Hunian (%)',
        data: avgByDay,
        backgroundColor: avgByDay.map(v =>
          v < 50  ? 'rgba(16,185,129,0.7)' :
          v < 75  ? 'rgba(245,158,11,0.7)' :
          v < 90  ? 'rgba(244,63,94,0.7)' :
                    'rgba(124,58,237,0.7)'
        ),
        borderColor: avgByDay.map(v =>
          v < 50  ? '#10b981' : v < 75 ? '#f59e0b' : v < 90 ? '#f43f5e' : '#7c3aed'
        ),
        borderWidth: 2,
        borderRadius: 8,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor:'rgba(10,6,24,0.95)',
          borderColor:'rgba(255,255,255,0.1)',
          borderWidth:1,
          titleColor:'white',
          bodyColor:'rgba(255,255,255,0.7)',
          padding:12,
          callbacks: { label: ctx => `Rata-rata: ${ctx.parsed.y}%` }
        }
      },
      scales: {
        x: { ticks:{color:'rgba(255,255,255,0.5)',font:{size:12}}, grid:{display:false} },
        y: { ticks:{color:'rgba(255,255,255,0.4)',font:{size:11},callback:v=>`${v}%`}, grid:{color:'rgba(255,255,255,0.05)'}, min:0, max:100 }
      }
    }
  });
}

// ─── Prediction Day Chart ────────────────────────────────────
function buildPredictionChart(canvasId, dayPred) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (APP.charts[canvasId]) APP.charts[canvasId].destroy();

  const hours = Array.from({length:16}, (_,i) => i + 6);
  const preds = hours.map(h => dayPred?.hourly_predictions?.[h]);

  const rates  = preds.map(p => Math.round((p?.predicted_occupancy_rate ?? 0) * 100));
  const lowers = preds.map(p => Math.round((p?.confidence_lower ?? 0) * 100));
  const uppers = preds.map(p => Math.round((p?.confidence_upper ?? 0) * 100));
  const avails = preds.map(p => p?.predicted_available ?? 0);

  APP.charts[canvasId] = new Chart(canvas, {
    type: 'line',
    data: {
      labels: hours.map(fmtHour),
      datasets: [
        {
          label: 'Prediksi Hunian (%)',
          data: rates,
          borderColor: '#a89df5',
          backgroundColor: 'rgba(168,157,245,0.15)',
          borderWidth: 2.5,
          fill: false,
          tension: 0.4,
          pointBackgroundColor: '#a89df5',
          pointRadius: 5,
          pointHoverRadius: 8,
          order: 1,
        },
        {
          label: 'Batas Atas',
          data: uppers,
          borderColor: 'rgba(244,63,94,0.35)',
          borderDash: [5,3],
          borderWidth: 1.5,
          fill: '+1',
          backgroundColor: 'rgba(168,157,245,0.08)',
          tension: 0.4,
          pointRadius: 0,
          order: 2,
        },
        {
          label: 'Batas Bawah',
          data: lowers,
          borderColor: 'rgba(16,185,129,0.35)',
          borderDash: [5,3],
          borderWidth: 1.5,
          fill: false,
          tension: 0.4,
          pointRadius: 0,
          order: 3,
        },
        {
          label: 'Slot Tersedia',
          data: avails,
          borderColor: '#10b981',
          backgroundColor: 'transparent',
          borderWidth: 2,
          fill: false,
          tension: 0.4,
          pointRadius: 0,
          yAxisID: 'y2',
          order: 4,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect:false, mode:'index' },
      plugins: {
        legend: { labels: { color:'rgba(255,255,255,0.65)', font:{size:11}, boxWidth:12 }},
        tooltip: {
          backgroundColor:'rgba(10,6,24,0.95)',
          borderColor:'rgba(255,255,255,0.1)',
          borderWidth:1,
          titleColor:'white',
          bodyColor:'rgba(255,255,255,0.7)',
          padding:12,
        }
      },
      scales: {
        x: { ticks:{color:'rgba(255,255,255,0.4)',font:{size:11}}, grid:{color:'rgba(255,255,255,0.05)'} },
        y: { ticks:{color:'rgba(255,255,255,0.4)',font:{size:11},callback:v=>`${v}%`}, grid:{color:'rgba(255,255,255,0.05)'}, min:0, max:100 },
        y2: { position:'right', ticks:{color:'rgba(16,185,129,0.6)',font:{size:11}}, grid:{display:false} }
      }
    }
  });
}

// ─── Dataset Activity Chart ──────────────────────────────────
function buildActivityChart(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !APP.parkingData) return;
  if (APP.charts[canvasId]) APP.charts[canvasId].destroy();

  const counts = APP.parkingData.meta?.activity_counts || {};
  const top10 = Object.entries(counts).slice(0, 10);

  APP.charts[canvasId] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: top10.map(([k]) => k.replace(/_/g, ' ')),
      datasets: [{
        label: 'Frekuensi Aktivitas',
        data: top10.map(([,v]) => v),
        backgroundColor: [
          'rgba(124,108,248,0.8)','rgba(0,212,255,0.7)','rgba(217,70,239,0.7)',
          'rgba(16,185,129,0.7)','rgba(245,158,11,0.7)','rgba(244,63,94,0.7)',
          'rgba(124,108,248,0.6)','rgba(0,212,255,0.5)','rgba(217,70,239,0.5)','rgba(16,185,129,0.5)',
        ],
        borderWidth: 0,
        borderRadius: 6,
        borderSkipped: false,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display:false },
        tooltip: {
          backgroundColor:'rgba(10,6,24,0.95)',
          borderColor:'rgba(255,255,255,0.1)',
          borderWidth:1,
          titleColor:'white',
          bodyColor:'rgba(255,255,255,0.7)',
          padding:12,
        }
      },
      scales: {
        x: { ticks:{color:'rgba(255,255,255,0.4)',font:{size:11}}, grid:{color:'rgba(255,255,255,0.05)'} },
        y: { ticks:{color:'rgba(255,255,255,0.7)',font:{size:11}}, grid:{display:false} }
      }
    }
  });
}

// ─── Hourly Prediction List ──────────────────────────────────
function renderPredictionList(container, dayPred) {
  if (!container || !dayPred) return;
  container.innerHTML = '';

  const hours = Array.from({length:16}, (_,i) => i + 6);
  hours.forEach(h => {
    const p = dayPred.hourly_predictions?.[h];
    if (!p) return;

    const rate = p.predicted_occupancy_rate;
    const status = STATUS.getStatus(rate);
    const lower = Math.round(p.confidence_lower * 100);
    const upper = Math.round(p.confidence_upper * 100);
    const ci_left = Math.round(Math.min(lower, upper));
    const ci_width = Math.abs(upper - lower);

    const item = document.createElement('div');
    item.className = 'prediction-hour-card';
    item.innerHTML = `
      <div class="pred-time">${fmtHour(h)}</div>
      <div class="pred-bar-wrap">
        <div class="pred-bar">
          <div class="pred-bar-ci" style="left:${ci_left}%;width:${ci_width}%"></div>
          <div class="pred-bar-fill" style="width:${Math.round(rate*100)}%;background:${status.color}"></div>
        </div>
        <div style="margin-top:4px;font-size:0.7rem;color:rgba(255,255,255,0.4);">${p.recommendation}</div>
      </div>
      <span class="status-badge ${status.class}">${status.label}</span>
      <div class="pred-slots" style="color:${status.color}">${p.predicted_available}</div>
    `;
    container.appendChild(item);
  });
}

// ─── Navbar active state & hamburger ────────────────────────
function initNavbar() {
  const page = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.navbar-nav a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === page || (page === '' && href === 'index.html')) {
      a.classList.add('active');
    }
  });

  const hamburger = document.getElementById('hamburger');
  const nav       = document.getElementById('navbar-nav');
  if (hamburger && nav) {
    hamburger.addEventListener('click', () => {
      hamburger.classList.toggle('open');
      nav.classList.toggle('mobile-open');
    });
    nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
      hamburger.classList.remove('open');
      nav.classList.remove('mobile-open');
    }));
  }
}

// ─── Number counter animation ────────────────────────────────
function animateCounter(el, target, duration = 1200, suffix = '') {
  const start = performance.now();
  const initial = 0;
  const update = (time) => {
    const progress = Math.min((time - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(initial + (target - initial) * eased) + suffix;
    if (progress < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

// ─── MQTT Real-time updates handler ─────────────────────────
function updateGlobalOccupancyRealtime(zoneId, isOccupying) {
  if (!APP.parkingData) return;
  const today = getTodayData();
  const currentHour = Math.min(Math.max(new Date().getHours(), 6), 21);
  const hourData = today?.hourly?.[currentHour];
  
  if (hourData && hourData.zona && hourData.zona[zoneId]) {
    const zone = hourData.zona[zoneId];
    
    if (isOccupying) {
      if (zone.terisi < zone.kapasitas) {
        zone.terisi += 1;
        zone.tersedia -= 1;
        hourData.total_terisi += 1;
        hourData.total_tersedia -= 1;
      }
    } else {
      if (zone.terisi > 0) {
        zone.terisi -= 1;
        zone.tersedia += 1;
        hourData.total_terisi -= 1;
        hourData.total_tersedia += 1;
      }
    }
    
    // Hitung ulang occupancy rate
    zone.occupancy_rate = zone.terisi / zone.kapasitas;
    hourData.total_occupancy_rate = hourData.total_terisi / APP.parkingData.config.total_slot;
    
    // Ambil input seleksi waktu di dashboard
    const hourSel = document.getElementById('hour-select');
    const daySel = document.getElementById('day-select');
    
    if (hourSel && daySel) {
      const selectedHour = parseInt(hourSel.value);
      const selectedDayIdx = parseInt(daySel.value);
      const todayIdx = APP.parkingData.daily_data.indexOf(today);
      
      // Jika user sedang melihat jam dan hari ini, re-render tampilan instan
      if (selectedHour === currentHour && selectedDayIdx === todayIdx) {
        if (window.renderAllPage) {
          window.renderAllPage(selectedHour, selectedDayIdx);
        }
      }
    }
  }
}

function initMQTTConnection() {
  const badge = document.getElementById('mqtt-status-badge');
  if (!window.mqtt) {
    console.error('[MQTT] Library MQTT.js tidak ditemukan! Cek CDN script tag.');
    if (badge) {
      badge.textContent = 'MQTT: ERROR';
      badge.style.background = 'rgba(239, 68, 68, 0.1)';
      badge.style.color = '#ef4444';
      badge.style.borderColor = 'rgba(239, 68, 68, 0.2)';
    }
    return;
  }

  console.log('[MQTT] Menghubungkan ke broker.hivemq.com:8000 via WebSockets...');
  const client = mqtt.connect('wss://broker.hivemq.com:8000/mqtt');

  client.on('connect', () => {
    console.log('[MQTT] Terhubung ke Broker MQTT HiveMQ!');
    if (badge) {
      badge.textContent = 'MQTT: ONLINE';
      badge.style.background = 'rgba(16, 185, 129, 0.1)';
      badge.style.color = '#10b981';
      badge.style.borderColor = 'rgba(16, 185, 129, 0.2)';
    }

    client.subscribe('smartpark/kampus/occupancy', (err) => {
      if (!err) {
        console.log('[MQTT] Sukses subscribe ke topik: smartpark/kampus/occupancy');
      } else {
        console.error('[MQTT] Gagal subscribe:', err);
      }
    });
  });

  client.on('close', () => {
    console.warn('[MQTT] Koneksi terputus dengan Broker.');
    if (badge) {
      badge.textContent = 'MQTT: OFFLINE';
      badge.style.background = 'rgba(244, 63, 94, 0.1)';
      badge.style.color = '#f43f5e';
      badge.style.borderColor = 'rgba(244, 63, 94, 0.2)';
    }
  });

  client.on('error', (err) => {
    console.error('[MQTT] Terjadi error:', err);
    if (badge) {
      badge.textContent = 'MQTT: ERROR';
      badge.style.background = 'rgba(239, 68, 68, 0.1)';
      badge.style.color = '#ef4444';
      badge.style.borderColor = 'rgba(239, 68, 68, 0.2)';
    }
  });

  client.on('message', (topic, message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('[MQTT] Payload diterima:', data);

      // 1. Update visual hardware slot cards
      if (data.slots && Array.isArray(data.slots)) {
        data.slots.forEach((slot, index) => {
          const card = document.getElementById(`hw-slot-${index}`);
          const distEl = document.getElementById(`hw-slot-dist-${index}`);
          if (card) {
            if (slot.terisi) {
              card.className = 'hardware-slot-card hw-occupied';
              const statusEl = card.querySelector('.hw-slot-status');
              if (statusEl) statusEl.textContent = 'TERISI';
            } else {
              card.className = 'hardware-slot-card hw-available';
              const statusEl = card.querySelector('.hw-slot-status');
              if (statusEl) statusEl.textContent = 'KOSONG';
            }
          }
          if (distEl) {
            distEl.textContent = `${slot.jarak_cm.toFixed(1)} cm`;
          }
        });
      }

      // 2. Update gate status
      const gateCard = document.getElementById('hw-gate-card');
      const gateStatus = document.getElementById('hw-gate-status');
      const gateIcon = document.getElementById('hw-gate-icon');
      const gateDetail = document.getElementById('hw-gate-detail');

      if (data.gate_status) {
        const isOpen = data.gate_status === 'open';
        if (isOpen) {
          if (gateCard) gateCard.className = 'hardware-gate-card hw-gate-open';
          if (gateStatus) {
            gateStatus.textContent = 'OPEN';
            gateStatus.style.color = '#00d4ff';
          }
          if (gateIcon) gateIcon.textContent = '🚧';
          if (gateDetail) gateDetail.textContent = 'Sudut: 90°';
        } else {
          if (gateCard) gateCard.className = 'hardware-gate-card';
          if (gateStatus) {
            gateStatus.textContent = 'CLOSED';
            gateStatus.style.color = '#f43f5e';
          }
          if (gateIcon) gateIcon.textContent = '🚧';
          if (gateDetail) gateDetail.textContent = 'Sudut: 0°';
        }
      }

      // 3. Sensor feed real-time update & log
      const feedEl = document.getElementById('sensor-feed');
      if (feedEl) {
        if (!APP.lastHardwareState) {
          APP.lastHardwareState = data;
        } else {
          // Cek transisi status slot
          data.slots.forEach((slot, i) => {
            const prevSlot = APP.lastHardwareState.slots[i];
            if (prevSlot && prevSlot.terisi !== slot.terisi) {
              const zone = (slot.id.includes('A') || i < 2) ? 'A' : 'B';
              const event = {
                time: new Date().toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit' }),
                sensor: `Wokwi [${slot.id}]`,
                activity: slot.terisi ? 'Kendaraan Masuk' : 'Kendaraan Keluar',
                type: slot.terisi ? 'enter' : 'exit',
                detail: `Sensor ultrasonik mendeteksi ${slot.id} di Zona ${zone} ${slot.terisi ? 'Terisi' : 'Kosong'} [Jarak: ${slot.jarak_cm.toFixed(1)}cm]`,
                zone: zone
              };
              addSensorEventToFeed(feedEl, event);
              updateGlobalOccupancyRealtime(zone, slot.terisi);
            }
          });

          // Cek transisi gerbang otomatis
          if (APP.lastHardwareState.gate_status !== data.gate_status) {
            const isOpen = data.gate_status === 'open';
            const event = {
              time: new Date().toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit' }),
              sensor: 'Gate Utama ESP32',
              activity: isOpen ? 'Pintu Terbuka' : 'Pintu Tertutup',
              type: 'sensor',
              detail: `Gerbang otomatis berubah menjadi ${isOpen ? 'TERBUKA (Servo 90°)' : 'TERTUTUP (Servo 0°)'}`,
              zone: 'A'
            };
            addSensorEventToFeed(feedEl, event);
          }

          APP.lastHardwareState = data;
        }
      }

    } catch (e) {
      console.error('[MQTT] Gagal parse JSON message:', e);
    }
  });

  APP.mqttClient = client;
}

// ─── Export ──────────────────────────────────────────────────
window.APP    = APP;
window.STATUS = STATUS;
window.loadData   = loadData;
window.startClock = startClock;
window.startSensorFeed    = startSensorFeed;
window.renderZoneCards    = renderZoneCards;
window.renderProgressRing = renderProgressRing;
window.buildHeatmap       = buildHeatmap;
window.buildTrendChart    = buildTrendChart;
window.buildWeeklyChart   = buildWeeklyChart;
window.buildPredictionChart   = buildPredictionChart;
window.buildActivityChart     = buildActivityChart;
window.renderPredictionList   = renderPredictionList;
window.getTodayData   = getTodayData;
window.getHourData    = getHourData;
window.animateCounter = animateCounter;
window.fmtHour = fmtHour;
window.fmtPct  = fmtPct;
window.fmtNum  = fmtNum;
window.initNavbar = initNavbar;
window.generateSensorEvent  = generateSensorEvent;
window.addSensorEventToFeed = addSensorEventToFeed;
window.initMQTTConnection = initMQTTConnection;
window.updateGlobalOccupancyRealtime = updateGlobalOccupancyRealtime;
