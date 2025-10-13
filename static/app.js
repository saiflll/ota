// static/app.js
// Frontend for IoT OTA & Monitor
// - Sends JSON to /set-threshold in this format:
//   { node, min, max, ck, area, no }
// - Uses prompt flow for inputs (min -> max -> ck -> area -> no)
// - Node IDs are shown as-is (server provides them)

async function fetchFiles() {
  try {
    const res = await fetch('/api/files');
    const files = await res.json();
    const fileList = document.getElementById('fileList');
    fileList.innerHTML = '';
    if (!files || files.length === 0) {
      fileList.innerHTML = '<div class="text-sm text-slate-400">No files</div>';
      return;
    }
    files.forEach(f => {
      const el = document.createElement('div');
      el.className = 'flex justify-between items-center bg-slate-700 p-2 rounded';
      const uploadTime = f.upload_time ? new Date(f.upload_time).toLocaleString() : '';
      el.innerHTML = `
        <div class="truncate pr-2">${escapeHtml(f.name)}</div>
        <div class="text-xs text-slate-400 mr-3">${uploadTime}</div>
        <div class="flex items-center gap-2">
          <button class="text-xs px-2 py-1 bg-slate-600 rounded" onclick="copyLink('${location.origin+f.url}')">Copy</button>
          <button class="text-xs px-2 py-1 bg-blue-600 rounded" onclick="renameFile('${encodeURIComponent(f.name)}')">Rename</button>
          <a class="text-indigo-300 hover:underline text-sm" href="${f.url}" target="_blank">Download</a>
          <button class="text-xs px-2 py-1 bg-red-600 rounded" onclick="deleteFile('${encodeURIComponent(f.name)}')">Delete</button>
        </div>`;
      fileList.appendChild(el);
    });
  } catch (err) {
    console.error(err);
  }
}

function copyLink(url) {
  navigator.clipboard?.writeText(url).then(() => {
    alert('Link copied: ' + url);
  }).catch(() => {
    // fallback
    const textarea = document.createElement('textarea');
    textarea.value = url;
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      alert('Link copied: ' + url);
    } catch (err) {
      alert('Failed to copy link.');
    }
    document.body.removeChild(textarea);
  });
}

async function renameFile(nameEnc) {
  const name = decodeURIComponent(nameEnc);
  const newName = prompt('Enter new name for ' + name);
  if (!newName || newName === name) return;

  const res = await fetch('/api/files/' + encodeURIComponent(name) + '/rename', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({new_name: newName})
  });
  const j = await res.json();
  if (res.ok) {
    alert('Renamed to: ' + newName);
    fetchFiles();
  } else {
    alert('Rename failed: ' + (j.error || 'unknown'));
  }
}

async function deleteNode(node) {
  if (!confirm(`Delete node ${node}?`)) return;
  const res = await fetch('/api/nodes/' + encodeURIComponent(node), { method: 'DELETE' });
  const j = await res.json();
  if (res.ok) {
    alert('Deleted: ' + node);
    fetchNodes();
  } else {
    alert('Delete failed: ' + (j.error || 'unknown'));
  }
}

async function deleteFile(nameEnc) {
  if (!confirm('Delete file?')) return;
  const name = decodeURIComponent(nameEnc);
  const res = await fetch('/api/files/' + encodeURIComponent(name), { method: 'DELETE' });
  const j = await res.json();
  if (res.ok) {
    alert('Deleted: ' + name);
    fetchFiles();
  } else {
    alert('Delete failed: ' + (j.error || 'unknown'));
  }
}

async function fetchNodes() {
  try {
    const res = await fetch('/api/nodes');
    const nodes = await res.json();
    renderNodes(nodes);
  } catch (err) {
    console.error(err);
  }
}

function renderNodes(nodes) {
  const area = document.getElementById('nodesArea');
  area.innerHTML = '';
  const keys = Object.keys(nodes).sort();
  if (keys.length === 0) {
    area.innerHTML = '<div class="text-sm text-slate-400">No nodes yet (waiting MQTT messages)</div>';
    return;
  }

  keys.forEach(k => {
    const info = nodes[k] || {};
    const status = info.status || '';
    const isOnline = (String(status).toLowerCase() === 'online' || String(status).toLowerCase().includes('running'));
    const dot = isOnline ? 'bg-emerald-400' : 'bg-red-500';
    const ram = info.ram_free_bytes !== undefined ? formatBytes(info.ram_free_bytes) : '-';
    const updated = info.updated || '';

    const card = document.createElement('div');
    card.className = 'bg-slate-700 p-4 rounded shadow';
    card.innerHTML = `
      <div class="flex justify-between items-start">
        <div class="font-semibold text-lg truncate">${escapeHtml(k)}</div>
        <div class="flex items-center gap-2">
          <div class="w-3 h-3 rounded-full ${dot}"></div>
          <div class="text-sm text-slate-300">${escapeHtml(String(status))}</div>
        </div>
      </div>

      <div class="mt-3 text-sm text-slate-300 space-y-1">
        <div>RAM Free: <span class="text-slate-100 font-medium">${ram}</span></div>
        <div class="text-xs text-slate-400 mt-2">Last: ${escapeHtml(updated)}</div>
      </div>

      <div class="mt-3 flex gap-2 flex-wrap">
        <button class="px-3 py-1 bg-indigo-500 rounded text-sm" onclick="openOTAModal('${encodeURIComponent(k)}')">OTA</button>
        <button class="px-3 py-1 bg-green-500 rounded text-sm" onclick="openThresholdModal('${encodeURIComponent(k)}')">Set Threshold</button>
        <button class="px-3 py-1 bg-yellow-500 rounded text-sm" onclick="openEditModal('${encodeURIComponent(k)}')">Edit</button>
        <button class="px-3 py-1 bg-gray-600 rounded text-sm" onclick="openLogModal('${encodeURIComponent(k)}')">Lihat Log</button>
        <button class="px-3 py-1 bg-red-600 rounded text-sm" onclick="deleteNode('${encodeURIComponent(k)}')">Delete</button>
      </div>
    `;
    area.appendChild(card);
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes == 0) return '0 B';
  const kb = 1024;
  if (bytes < kb) return bytes + ' B';
  if (bytes < kb * kb) return Math.round(bytes / kb) + ' KB';
  return Math.round(bytes / (kb * kb)) + ' MB';
}

// === Threshold flow (used by Set Threshold and Edit) ===
// Prompts: min -> max -> ck -> area -> no
// Sends JSON: { node, min, max, ck, area, no } to POST /set-threshold

async function promptThresholdFlow(node) {
  // node is encoded; decode for payload
  const decodedNode = decodeURIComponent(node);

  const minStr = prompt('Set min temperature (°C):', '16');
  if (minStr === null) return null;
  const maxStr = prompt('Set max temperature (°C):', '20');
  if (maxStr === null) return null;
  const ck = prompt('Set ck (string):', '');
  if (ck === null) return null;
  const area = prompt('Set area (string):', '');
  if (area === null) return null;
  const no = prompt('Set no (string):', '');
  if (no === null) return null;

  const min = parseFloat(minStr);
  const max = parseFloat(maxStr);

  return {
    node: decodedNode,
    min,
    max,
    ck: String(ck),
    area: String(area),
    no: String(no)
  };
}

async function openThresholdModal(nodeEnc) {
  const payload = await promptThresholdFlow(nodeEnc);
  if (!payload) return;
  try {
    const res = await fetch('/set-threshold', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const j = await res.json();
    if (res.ok) {
      alert('Threshold sent: ' + JSON.stringify(j));
      // refresh nodes list after small delay
      setTimeout(fetchNodes, 800);
    } else {
      alert('Failed: ' + (j.error || JSON.stringify(j)));
    }
  } catch (err) {
    alert('Network error: ' + err.message);
  }
}

// Edit uses the same flow (backend handles same payload)
async function openEditModal(nodeEnc) {
  const payload = await promptThresholdFlow(nodeEnc);
  if (!payload) return;
  // For edit, we reuse same endpoint so behavior stays consistent
  try {
    const res = await fetch('/set-threshold', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const j = await res.json();
    if (res.ok) {
      alert('Edit sent: ' + JSON.stringify(j));
      setTimeout(fetchNodes, 800);
    } else {
      alert('Failed edit: ' + (j.error || JSON.stringify(j)));
    }
  } catch (err) {
    alert('Network error: ' + err.message);
  }
}

async function openOTAModal(nodeEnc) {
  const node = decodeURIComponent(nodeEnc);
  const urlDefault = location.origin + '/files/';
  const url = prompt('Enter OTA URL (full URL, e.g. ' + urlDefault + 'firmware.bin )');
  if (!url) return;
  try {
    const res = await fetch('/ota', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({node, url})
    });
    const j = await res.json();
    if (res.ok) {
      alert('OTA sent: ' + JSON.stringify(j));
    } else {
      alert('OTA failed: ' + (j.error || JSON.stringify(j)));
    }
  } catch (err) {
    alert('Network error: ' + err.message);
  }
}

// LOG modal
function openLogModal(nodeEnc) {
  const node = decodeURIComponent(nodeEnc);
  document.getElementById('modalNode').textContent = node;
  const modal = document.getElementById('logModal');
  const body = document.getElementById('modalBody');
  body.textContent = 'Loading...';
  modal.classList.remove('hidden');
  modal.classList.add('flex');

  fetch('/logs/' + encodeURIComponent(node))
    .then(r => {
      if (!r.ok) throw new Error('No logs');
      return r.json();
    })
    .then(j => {
      const logs = j.logs || [];
      if (logs.length === 0) {
        body.innerHTML = '<div class="text-sm text-slate-400">No logs</div>';
      } else {
        body.innerHTML = logs.map(l => `<div class="mb-1 text-xs text-slate-200">▶ ${escapeHtml(l)}</div>`).join('');
      }
    }).catch(err => {
      body.innerHTML = '<div class="text-sm text-slate-400">No logs / node not found</div>';
    });
}

function closeModal() {
  const modal = document.getElementById('logModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

// simple escape to avoid HTML injection
function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
       .replaceAll('&', '&amp;')
       .replaceAll('<', '&lt;')
       .replaceAll('>', '&gt;')
       .replaceAll('"', '&quot;')
       .replaceAll("'", '&#039;');
}

// upload form
document.addEventListener('DOMContentLoaded', function() {
  const form = document.getElementById('uploadForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = document.getElementById('fileInput').files[0];
    if (!file) return alert('Pilih file terlebih dahulu');
    const fd = new FormData();
    fd.append('file', file);
    document.getElementById('uploadMsg').textContent = 'Uploading...';
    try {
      const res = await fetch('/upload', { method: 'POST', body: fd });
      if (res.redirected) {
        document.getElementById('uploadMsg').textContent = 'Upload OK';
      } else {
        document.getElementById('uploadMsg').textContent = 'Upload finished';
      }
      setTimeout(()=> fetchFiles(), 800);
    } catch (err) {
      document.getElementById('uploadMsg').textContent = 'Upload error';
      console.error(err);
    }
  });

  // initial load + interval
  fetchFiles();
  fetchNodes();
  setInterval(fetchFiles, 5000);
  setInterval(fetchNodes, 5000);
});
