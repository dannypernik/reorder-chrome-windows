const ORDER_KEY = 'windowOrder';
const TITLE_OVERRIDES_KEY = 'windowTitleOverrides';

let draggedItem = null;

function showStatus(message, type = 'ok') {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message || '';
  statusEl.className = '';
  if (message) {
    statusEl.classList.add(type);
  }
}

function getStoredOrder() {
  return new Promise((resolve) => {
    chrome.storage.local.get(ORDER_KEY, (data) => {
      resolve(data[ORDER_KEY] || null);
    });
  });
}

function setStoredOrder(order) {
  return new Promise((resolve) => {
    const obj = {};
    obj[ORDER_KEY] = order;
    chrome.storage.local.set(obj, resolve);
  });
}

function getTitleOverrides() {
  return new Promise((resolve) => {
    chrome.storage.local.get(TITLE_OVERRIDES_KEY, (data) => {
      resolve(data[TITLE_OVERRIDES_KEY] || {});
    });
  });
}

function setTitleOverrides(overrides) {
  return new Promise((resolve) => {
    const obj = {};
    obj[TITLE_OVERRIDES_KEY] = overrides;
    chrome.storage.local.set(obj, resolve);
  });
}

function getAllNormalWindows() {
  // populate: true so we can access tabs and titles
  return new Promise((resolve) => {
    chrome.windows.getAll({ windowTypes: ['normal'], populate: true }, (windows) => {
      resolve(windows);
    });
  });
}

function getActiveBrowserWindowId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        resolve(tabs[0].windowId);
      } else {
        resolve(null);
      }
    });
  });
}

async function buildEffectiveOrder() {
  const [windows, storedOrder] = await Promise.all([getAllNormalWindows(), getStoredOrder()]);

  const currentIds = windows.map((w) => w.id);
  let order = storedOrder;

  if (!order || !Array.isArray(order) || order.length === 0) {
    order = currentIds;
  } else {
    const setCurrent = new Set(currentIds);
    // keep only existing windows
    order = order.filter((id) => setCurrent.has(id));

    const setOrder = new Set(order);
    const newOnes = currentIds.filter((id) => !setOrder.has(id));
    order = order.concat(newOnes);

    if (order.length === 0) {
      order = currentIds;
    }
  }

  await setStoredOrder(order);
  return { windows, order };
}

function getWindowTitle(win) {
  if (win.tabs && win.tabs.length > 0) {
    const activeTab = win.tabs.find((t) => t.active) || win.tabs[0];
    return activeTab.title || 'Window';
  }
  return 'Window';
}

function clearList() {
  const list = document.getElementById('window-list');
  while (list.firstChild) {
    list.removeChild(list.firstChild);
  }
}

async function handleEditTitle(windowId, originalTitle, li) {
  const key = String(windowId);
  const overrides = await getTitleOverrides();

  const titleSpan = li.querySelector('.window-title');
  const subline = li.querySelector('.window-subline');

  if (!titleSpan) return;

  const currentOverride = overrides[key] || '';
  const initial = currentOverride || originalTitle;

  // Replace title span with input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'window-title-input';
  input.value = initial;
  input.dataset.original = originalTitle;

  // Replace element
  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  // Save logic
  const commit = async () => {
    const trimmed = input.value.trim();

    if (trimmed && trimmed !== originalTitle) {
      overrides[key] = trimmed;
    } else {
      delete overrides[key];
    }
    await setTitleOverrides(overrides);

    // Rebuild the title span
    const newTitle = document.createElement('span');
    newTitle.className = 'window-title';
    newTitle.textContent = trimmed || originalTitle;

    if (trimmed && trimmed !== originalTitle) {
      newTitle.classList.add('window-title-custom');
    }

    input.replaceWith(newTitle);

    // Update subtitle
    if (trimmed && trimmed !== originalTitle) {
      subline.textContent = originalTitle;
    } else {
      subline.textContent = '\u00A0';
    }

    // Add click handler back to new title (for future editing!)
    newTitle.addEventListener('mousedown', (e) => e.stopPropagation());
  };

  // Cancel logic (Escape)
  const cancel = () => {
    const restored = document.createElement('span');
    restored.className = 'window-title';
    restored.textContent = initial;
    input.replaceWith(restored);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') cancel();
  });

  input.addEventListener('blur', commit);
}

function createListItem(win, isActive, overrides) {
  const li = document.createElement('li');
  li.className = 'window-item';
  li.draggable = true;
  li.dataset.windowId = String(win.id);

  const originalTitle = getWindowTitle(win);
  li.dataset.originalTitle = originalTitle;

  const key = String(win.id);
  const override = (overrides[key] || '').trim();
  const mainTitle = override || originalTitle;

  const main = document.createElement('div');
  main.className = 'window-main';

  const titleLine = document.createElement('div');
  titleLine.className = 'window-title-line';

  //
  // EDIT ICON (left)
  //
  const editIcon = document.createElement('span');
  editIcon.className = 'window-edit-icon';
  editIcon.title = 'Rename this window';
  editIcon.textContent = '✎';

  editIcon.addEventListener('mousedown', (e) => e.stopPropagation());
  editIcon.addEventListener('click', (e) => {
    e.stopPropagation();
    handleEditTitle(win.id, originalTitle, li);
  });

  //
  // TITLE BLOCK (column: title row + subline)
  //
  const titleBlock = document.createElement('div');
  titleBlock.style.display = 'flex';
  titleBlock.style.flexDirection = 'column';
  titleBlock.style.flex = '1';
  titleBlock.style.minWidth = '0';

  //
  // TITLE ROW
  //
  const titleRow = document.createElement('div');
  titleRow.style.display = 'flex';
  titleRow.style.alignItems = 'center';
  titleRow.style.gap = '6px';
  titleRow.style.minWidth = '0';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'window-title';
  titleSpan.textContent = mainTitle;

  if (override && override !== originalTitle) {
    titleSpan.classList.add('window-title-custom');
  }

  const tabsCountSpan = document.createElement('span');
  tabsCountSpan.className = 'window-tabs-count';
  const tabCount = win.tabs ? win.tabs.length : 0;
  tabsCountSpan.textContent = `(${tabCount} tab${tabCount === 1 ? '' : 's'})`;

  //
  // FOCUS ICON (right)
  //
  const focusIcon = document.createElement('span');
  focusIcon.className = 'window-focus-icon';
  focusIcon.title = 'Switch to this window';
  // const svgUrl = chrome.runtime.getURL('go-to-window.svg');
  focusIcon.innerHTML = `<svg width="11px" height="11px" viewBox="0 0 391 394" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <g id="Page-1" stroke="none" stroke-width="1" fill-rule="evenodd">
        <path d="M275.869666,292.236778 C275.869666,281.731442 284.413674,273.202783 294.937917,273.202783 C305.455992,273.202783 314,281.731442 314,292.236778 L314,346.315247 C314,359.29605 308.676189,371.125331 300.113674,379.678621 C291.551159,388.225753 279.700589,393.54 266.690255,393.54 L47.3097446,393.54 C34.2994106,393.54 22.4488409,388.225753 13.8863261,379.678621 C5.32381139,371.125331 0,359.29605 0,346.315247 L0,125.764753 C0,112.777792 5.32381139,100.948512 13.8863261,92.4013794 C22.4488409,83.8542472 34.2994106,78.54 47.3097446,78.54 L100.967348,78.54 C111.491591,78.54 120.02943,87.0686586 120.02943,97.5678375 C120.02943,108.073174 111.491591,116.601833 100.967348,116.601833 L47.3097446,116.601833 C44.7989784,116.601833 42.4856189,117.642514 40.826169,119.292825 C39.172888,120.949294 38.130334,123.258497 38.130334,125.764753 L38.130334,346.315247 C38.130334,348.815345 39.172888,351.130706 40.826169,352.781017 C42.4856189,354.431328 44.7989784,355.478167 47.3097446,355.478167 L266.690255,355.478167 C269.201022,355.478167 271.514381,354.431328 273.173831,352.781017 C274.827112,351.130706 275.869666,348.815345 275.869666,346.315247 L275.869666,292.236778 Z M329.19,103.47 L190.15,244.28 C178.24,256.4 158.7,256.56 146.59,244.65 C134.48,232.74 134.31,213.2 146.22,201.09 L283.77,61.81 L191.7,61.81 C174.64,61.81 160.8,47.96 160.8,30.9 C160.8,13.85 174.64,0 191.7,0 L360.1,0 C377.15,0 391,13.85 391,30.9 L391,195.94 C391,213 377.15,226.84 360.1,226.84 C343.04,226.84 329.19,213 329.19,195.94 L329.19,103.47 Z" id="Shape"></path>
    </g>
</svg>`;
  focusIcon.style.cursor = 'pointer';
  // Place icon immediately after the visible title, before the tab count.
  focusIcon.style.order = '2';
  focusIcon.style.marginLeft = '6px';

  // Keep title first; prevent it from growing so the icon sits right after it.
  titleSpan.style.order = '0';
  titleSpan.style.flex = '0 1 auto';
  titleSpan.style.whiteSpace = 'nowrap';
  titleSpan.style.overflow = 'hidden';
  titleSpan.style.textOverflow = 'ellipsis';
  titleSpan.style.minWidth = '0';

  // Push the tab count to the far right so the focus icon stays next to the title.
  tabsCountSpan.style.order = '1';
  tabsCountSpan.style.marginLeft = 'auto';

  focusIcon.addEventListener('mousedown', (e) => e.stopPropagation());
  focusIcon.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.windows.update(win.id, { focused: true });
  });

  let activeIndicator = null;
  if (isActive) {
    activeIndicator = document.createElement('span');
    // activeIndicator.className = 'window-active-indicator';
    activeIndicator.title = 'Active window';
    li.classList.add('active-window');
  }

  titleRow.appendChild(titleSpan);
  if (activeIndicator) titleRow.appendChild(activeIndicator);
  titleRow.appendChild(tabsCountSpan);
  titleRow.appendChild(focusIcon);

  //
  // SUBTITLE
  //
  const subline = document.createElement('div');
  subline.className = 'window-subline';

  if (override && override !== originalTitle) {
    subline.textContent = originalTitle;
  } else {
    subline.textContent = '\u00A0'; // blank but keeps height unchanged
  }

  //
  // Assemble
  //
  titleBlock.appendChild(titleRow);
  titleBlock.appendChild(subline);

  titleLine.appendChild(editIcon);
  titleLine.appendChild(titleBlock);

  main.appendChild(titleLine);
  li.appendChild(main);

  //
  // Drag events on entire row
  //
  li.addEventListener('dragstart', handleDragStart);
  li.addEventListener('dragover', handleDragOver);
  li.addEventListener('dragleave', handleDragLeave);
  li.addEventListener('drop', handleDrop);
  li.addEventListener('dragend', handleDragEnd);

  return li;
}

function handleDragStart(e) {
  draggedItem = this;
  this.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.windowId || '');
  }
}

function handleDragOver(e) {
  e.preventDefault(); // necessary to allow a drop
  this.classList.add('over');
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move';
  }
}

function handleDragLeave(_e) {
  this.classList.remove('over');
}

function handleDrop(e) {
  e.preventDefault();
  this.classList.remove('over');

  const list = this.parentNode;
  if (!draggedItem || draggedItem === this) return;

  const children = Array.from(list.children);
  const draggedIndex = children.indexOf(draggedItem);
  const targetIndex = children.indexOf(this);

  if (draggedIndex < 0 || targetIndex < 0) return;

  if (draggedIndex < targetIndex) {
    list.insertBefore(draggedItem, this.nextSibling);
  } else {
    list.insertBefore(draggedItem, this);
  }
}

async function handleDragEnd(_e) {
  this.classList.remove('dragging');
  draggedItem = null;

  document.querySelectorAll('#window-list .over').forEach((el) => el.classList.remove('over'));

  // autosave new order based on current DOM
  await saveOrderFromDom(false);
}

async function loadWindowsIntoList() {
  showStatus('Loading windows...');
  try {
    const [activeWindowId, { windows, order }, overrides] = await Promise.all([getActiveBrowserWindowId(), buildEffectiveOrder(), getTitleOverrides()]);

    const list = document.getElementById('window-list');
    clearList();

    const winById = new Map();
    windows.forEach((w) => winById.set(w.id, w));

    let addedCount = 0;

    order.forEach((id) => {
      const win = winById.get(id);
      if (win) {
        const isActive = activeWindowId != null && id === activeWindowId;
        const li = createListItem(win, isActive, overrides);
        list.appendChild(li);
        addedCount++;
      }
    });

    if (addedCount === 0) {
      showStatus('No Chrome windows found.', 'error');
    } else {
      // clear status on success
      showStatus('');
    }
  } catch (err) {
    console.error(err);
    showStatus('Error loading windows.', 'error');
  }
}

async function saveOrderFromList() {
  const list = document.getElementById('window-list');
  const items = Array.from(list.children);
  const order = items.map((li) => Number(li.dataset.windowId));

  if (order.length === 0) {
    showStatus('Nothing to save.', 'error');
    return;
  }

  try {
    await setStoredOrder(order);
    showStatus('Order saved.', 'ok');
  } catch (err) {
    console.error(err);
    showStatus('Error saving order.', 'error');
  }
}

async function saveOrderFromDom(showMessage = false) {
  const list = document.getElementById('window-list');
  if (!list) return;

  const items = Array.from(list.children);
  const order = items.map((li) => Number(li.dataset.windowId)).filter((id) => !Number.isNaN(id));

  if (order.length === 0) return;

  try {
    await setStoredOrder(order);
    if (showMessage) {
      showStatus('Order saved.', 'ok');
      // optional: clear message after a moment
      setTimeout(() => showStatus(''), 800);
    }
  } catch (err) {
    console.error(err);
    showStatus('Error saving order.', 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadWindowsIntoList();
});
