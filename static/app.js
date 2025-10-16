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
          <button data-action="copy-link" data-url="${location.origin+f.url}" class="text-xs px-2 py-1 bg-slate-600 rounded">Copy</button>
          <button data-action="rename-file" data-name="${encodeURIComponent(f.name)}" class="text-xs px-2 py-1 bg-blue-600 rounded">Rename</button>
          <a class="text-indigo-300 hover:underline text-sm" href="${f.url}" target="_blank">Download</a>
          <button data-action="delete-file" data-name="${encodeURIComponent(f.name)}" class="text-xs px-2 py-1 bg-red-600 rounded">Delete</button>
        </div>`;
      fileList.appendChild(el);
    });
  } catch (err) {
    console.error(err);
  }
}

function copyLink(url) {
  navigator.clipboard?.writeText(url).then(() => {
    showToast('Link copied!', 'success');
  }).catch(() => {
    // fallback
    const textarea = document.createElement('textarea');
    textarea.value = url;
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      showToast('Link copied!', 'success');
    } catch (err) {
      showToast('Failed to copy link.', 'error');
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
    showToast(`Renamed to: ${newName}`, 'success');
    fetchFiles();
  } else {
    showToast(`Rename failed: ${j.error || 'unknown'}`, 'error');
  }
}

async function deleteNode(node) {
  if (!confirm(`Delete node ${decodeURIComponent(node)}?`)) return;
  const res = await fetch('/api/nodes/' + node, { method: 'DELETE' });
  const j = await res.json();
  if (res.ok) {
    showToast(`Deleted node: ${decodeURIComponent(node)}`, 'success');
    fetchNodes();
  } else {
    showToast(`Delete failed: ${j.error || 'unknown'}`, 'error');
  }
}

async function deleteFile(nameEnc) {
  if (!confirm('Delete file?')) return;
  const name = decodeURIComponent(nameEnc);
  const res = await fetch('/api/files/' + encodeURIComponent(name), { method: 'DELETE' });
  const j = await res.json();
  if (res.ok) {
    showToast(`Deleted file: ${name}`, 'success');
    fetchFiles();
  } else {
    showToast(`Delete failed: ${j.error || 'unknown'}`, 'error');
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
  const runningArea = document.getElementById('runningNodes');
  const offlineArea = document.getElementById('offlineNodes');
  runningArea.innerHTML = '';
  offlineArea.innerHTML = '';

  const keys = Object.keys(nodes).sort();
  let runningCount = 0;
  let offlineCount = 0;

  if (keys.length === 0) {
    runningArea.innerHTML = '<div class="text-sm text-slate-400 md:col-span-2">No nodes yet (waiting for MQTT messages)</div>';
    document.getElementById('count-running').textContent = '0';
    document.getElementById('count-offline').textContent = '0';
    return;
  }

  keys.forEach(k => {
    const formattedNodeId = formatNodeId(k);
    const info = nodes[k] || {};
    const status = info.status || '';
    // Status 'offline' is now explicitly set by the backend based on time
    const isOnline = String(status).toLowerCase() !== 'offline';
    const dot = isOnline ? 'bg-emerald-400' : 'bg-red-500';
    const ram = info.ram_free_bytes !== undefined ? formatBytes(info.ram_free_bytes) : '-';
    const sd_ok = info.sd_ok; // Will be true, false, or null/undefined
    const updated = info.updated || '';

    const card = document.createElement('div');
    card.className = 'bg-slate-700 p-4 rounded shadow';
    card.innerHTML = `
      <div class="flex justify-between items-start">
        <div class="font-semibold text-lg truncate" title="${escapeHtml(k)}">${formattedNodeId}</div>
        <div class="flex items-center gap-2">
          ${sd_ok !== undefined && sd_ok !== null ? `
            <div class="flex items-center gap-1.5" title="SD Card Status">
              <div class="w-3 h-3 rounded-full ${sd_ok ? 'bg-green-400' : 'bg-red-500'}"></div>
            </div>
          ` : ''}
          <div class="w-3 h-3 rounded-full ${dot}"></div>
          <div class="text-sm text-slate-300">${escapeHtml(String(status))}</div>
        </div>
      </div>

      <div class="mt-3 text-sm text-slate-300 space-y-1">
        <div>RAM Free: <span class="text-slate-100 font-medium">${ram}</span></div>
        <div class="text-xs text-slate-400 mt-2">Last: ${escapeHtml(updated)}</div>
      </div>

      <div class="mt-3 flex gap-2 flex-wrap">
        <button data-action="ota" data-node="${encodeURIComponent(k)}" class="px-3 py-1 bg-indigo-500 rounded text-sm">OTA</button>
        <button data-action="configure" data-node="${encodeURIComponent(k)}" class="px-3 py-1 bg-yellow-500 rounded text-sm">Configure</button>
        <button data-action="logs" data-node="${encodeURIComponent(k)}" class="px-3 py-1 bg-gray-600 rounded text-sm">Lihat Log</button>
        <button data-action="delete-node" data-node="${encodeURIComponent(k)}" class="px-3 py-1 bg-red-600 rounded text-sm">Delete</button>
      </div>
    `;

    if (isOnline) {
      runningArea.appendChild(card);
      runningCount++;
    } else {
      offlineArea.appendChild(card);
      offlineCount++;
    }
  });

  document.getElementById('count-running').textContent = runningCount;
  document.getElementById('count-offline').textContent = offlineCount;
  if (runningCount === 0) runningArea.innerHTML = '<div class="text-sm text-slate-400 md:col-span-2">No running nodes.</div>';
  if (offlineCount === 0) offlineArea.innerHTML = '<div class="text-sm text-slate-400 md:col-span-2">No offline nodes.</div>';
}

function formatBytes(bytes) {
  if (!bytes || bytes == 0) return '0 B';
  const kb = 1024;
  if (bytes < kb) return bytes + ' B';
  if (bytes < kb * kb) return Math.round(bytes / kb) + ' KB';
  return Math.round(bytes / (kb * kb)) + ' MB';
}

function formatNodeId(nodeId) {
  if (!nodeId) return '';

  // The MAC address is always the last 12 characters.
  if (nodeId.length < 12) {
    return escapeHtml(nodeId);
  }

  const mac = nodeId.slice(-12);
  let prefix = nodeId.slice(0, -12);

  // Format the prefix: replace hyphens and remove any trailing slash
  prefix = prefix.replace(/-/g, '/').replace(/\/$/, '');

  // Format MAC with colons
  const formattedMac = mac.match(/.{1,2}/g)?.join(':') || mac;

  return `${escapeHtml(prefix)} - <span class="text-indigo-300">${escapeHtml(formattedMac)}</span>`;
}

// === Config flow (used by Set Threshold and Edit) ===
async function promptConfigFlow(node, existingInfo) {
  const decodedNode = decodeURIComponent(node);
  const info = existingInfo || {};

  const minStr = prompt('Set min temperature (°C):', '16');
  if (minStr === null) return null;
  const maxStr = prompt('Set max temperature (°C):', '20');
  if (maxStr === null) return null;
  const ck = prompt('Set ck (string):', info.ck || '');
  if (ck === null) return null;
  const area = prompt('Set area (string):', info.area || '');
  if (area === null) return null;
  const no = prompt('Set no (string):', info.no || '');
  if (no === null) return null;

  return {
    node: decodedNode,
    min: parseFloat(minStr),
    max: parseFloat(maxStr),
    ck: String(ck),
    area: String(area),
    no: String(no)
  };
}

async function openConfigModal(nodeEnc, action = 'Config') {
  // Get current node data to pre-fill the prompts
  const nodesRes = await fetch('/api/nodes');
  const allNodes = await nodesRes.json();
  const nodeInfo = allNodes[decodeURIComponent(nodeEnc)];
  if (!nodeInfo) {
    return showToast('Node data not found, cannot configure.', 'error');
  }
  const payload = await promptConfigFlow(nodeEnc, nodeInfo);
  if (!payload) return;

  try {
    showToast(`Sending ${action}...`);
    const res = await fetch('/config', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const j = await res.json();
    if (res.ok) {
      showToast(`${action} sent successfully!`, 'success');
      setTimeout(fetchNodes, 800);
    } else {
      showToast(`Failed to send ${action}: ${j.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showToast(`Network error: ${err.message}`, 'error');
  }
}

/* The old openThresholdModal function has been removed as it is redundant. */


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
      showToast('OTA command sent!', 'success');
    } else {
      showToast(`OTA failed: ${j.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showToast(`Network error: ${err.message}`, 'error');
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

// Toast notification function
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  const colors = {
    info: 'bg-blue-500',
    success: 'bg-emerald-500',
    error: 'bg-red-500',
  };
  toast.className = `fixed bottom-5 right-5 px-4 py-2 rounded-md text-white shadow-lg transition-opacity duration-300 ${colors[type] || colors.info}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
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

  // Centralized event listener for all actions
  document.body.addEventListener('click', (e) => {
    const button = e.target.closest('[data-action]');
    if (!button) return;

    const action = button.dataset.action;
    const node = button.dataset.node;
    const name = button.dataset.name;
    const url = button.dataset.url;

    switch (action) {
      case 'ota':
        openOTAModal(node);
        break;
      case 'configure':
        openConfigModal(node, 'Configure');
        break;
      case 'logs':
        openLogModal(node);
        break;
      case 'delete-node':
        deleteNode(node);
        break;
      case 'copy-link':
        copyLink(url);
        break;
      case 'rename-file':
        renameFile(name);
        break;
      case 'delete-file':
        deleteFile(name);
        break;
      case 'close-modal':
        closeModal();
        break;
    }
  });

  // Tab switching logic
  const tabs = document.querySelectorAll('.tab-button');
  const tabContents = document.querySelectorAll('.tab-content');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Deactivate all tabs
      tabs.forEach(t => {
        t.classList.remove('border-indigo-500', 'text-indigo-400');
        t.classList.add('border-transparent', 'text-slate-400', 'hover:text-slate-200', 'hover:border-slate-400');
      });
      // Deactivate all content
      tabContents.forEach(c => c.classList.add('hidden'));

      // Activate clicked tab
      tab.classList.add('border-indigo-500', 'text-indigo-400');
      tab.classList.remove('border-transparent', 'text-slate-400', 'hover:text-slate-200', 'hover:border-slate-400');
      
      // Activate corresponding content
      const targetContentId = tab.id.replace('tab-', '') + 'Nodes';
      document.getElementById(targetContentId).classList.remove('hidden');
    });
  });

  // initial load + interval
  fetchFiles();
  fetchNodes();
  setInterval(fetchFiles, 5000);
  setInterval(fetchNodes, 5000);
});
