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
      el.innerHTML = `
        <div class="truncate">${f.name}</div>
        <div class="text-xs text-slate-400">${new Date(f.upload_time).toLocaleString()}</div>
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
    const status = info.status || 'unknown';
    const isOnline = (String(status).toLowerCase() === 'online');
    const dot = isOnline ? 'bg-emerald-400' : 'bg-red-500';
    const ram = info.ram_free_bytes !== undefined ? formatBytes(info.ram_free_bytes) : '-';
    const updated = info.updated || '';

    const card = document.createElement('div');
    card.className = 'bg-slate-700 p-4 rounded shadow';
    card.innerHTML = `
      <div class="flex justify-between items-start">
        <div class="font-semibold text-lg truncate">${k}</div>
        <div class="flex items-center gap-2">
          <div class="w-3 h-3 rounded-full ${dot}"></div>
          <div class="text-sm text-slate-300">${String(status)}</div>
        </div>
      </div>

      <div class="mt-3 text-sm text-slate-300 space-y-1">
        <div>RAM Free: <span class="text-slate-100 font-medium">${ram}</span></div>
        <div class="text-xs text-slate-400 mt-2">Last: ${updated}</div>
      </div>

      <div class="mt-3 flex gap-2">
        <button class="px-3 py-1 bg-indigo-500 rounded text-sm" onclick="openOTAModal('${k}')">OTA</button>
        <button class="px-3 py-1 bg-green-500 rounded text-sm" onclick="openThresholdModal('${k}')">Set Threshold</button>
        <button class="px-3 py-1 bg-gray-600 rounded text-sm" onclick="openLogModal('${k}')">Lihat Log</button>
        <button class="px-3 py-1 bg-red-600 rounded text-sm" onclick="deleteNode('${k}')">Delete</button>
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

// threshold modal via prompt (simple)
function openThresholdModal(node) {
  const min = prompt('Set min temperature (°C):', '16');
  if (min === null) return;
  const max = prompt('Set max temperature (°C):', '20');
  if (max === null) return;
  const ck = prompt('Set ck:');
  if (ck === null) return;
  const area = prompt('Set area:');
  if (area === null) return;
  const no = prompt('Set no:');
  if (no === null) return;
  fetch('/set-threshold', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({node, min: parseFloat(min), max: parseFloat(max), ck, area, no})
  }).then(r => r.json()).then(j => alert('Threshold sent: ' + JSON.stringify(j)));
}

function openOTAModal(node) {
  const url = prompt('Enter OTA URL (e.g. ' + location.origin + '/files/firm.bin )');
  if (!url) return;
  fetch('/ota', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({node, url})
  }).then(r => r.json()).then(j => alert('OTA sent: ' + JSON.stringify(j)));
}

// LOG modal
function openLogModal(node) {
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
  return unsafe
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
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    document.getElementById('uploadMsg').textContent = 'Uploading...';
    const res = await fetch('/upload', { method: 'POST', body: fd });
    if (res.redirected) {
      document.getElementById('uploadMsg').textContent = 'Upload OK';
    } else {
      document.getElementById('uploadMsg').textContent = 'Upload finished';
    }
    setTimeout(()=> fetchFiles(), 800);
  });

  // initial load + interval
  fetchFiles();
  fetchNodes();
  setInterval(fetchFiles, 5000);
  setInterval(fetchNodes, 5000);
});
