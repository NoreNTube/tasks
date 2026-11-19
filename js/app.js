/**
 * Логика приложения: задачи, интерфейс, синхронизация с Google Таблицей.
 * Зависимости: js/config.js, js/storage.js, js/api.js.
 */
(function () {
  'use strict';

  var Store = window.AppStorage;
  var Photos = window.AppPhotos;
  var Api = window.AppApi;
  var CONFIG = window.APP_CONFIG || {};

  var SYNC_INTERVAL = Math.max(20000, Number(CONFIG.syncIntervalMs) || 60000);
  var PUSH_DELAY = 900;

  var els = {};
  var state = {
    tasks: [],
    settings: Store.loadSettings(),
    filter: 'all',
    query: '',
    pendingPhotoCounts: {},
    syncing: false,
    queued: false,
    lastSyncAt: Store.getMeta().lastSyncAt,
    syncKind: 'idle',
    syncError: '',
    pushTimer: null,
    intervalId: null,
    toastTimer: null
  };

  // Состояние открытого диалога задачи (новой или существующей).
  var editor = {
    mode: 'edit',
    taskId: null,
    draftId: null,
    color: '',
    icon: '',
    subtasks: [],
    photos: [],
    removedPhotos: [],
    addedPhotoIds: [],
    saved: false,
    generation: 0
  };

  // Черновик акцентного цвета в открытом диалоге настроек.
  var settingsAccent = '';

  // Защита от повторных загрузок миниатюр, пока фото ещё нет в локальном кэше.
  var thumbInflight = Object.create(null);

  /* ------------------------------------------------------------------ */
  /*  Утилиты                                                            */
  /* ------------------------------------------------------------------ */

  function $(id) {
    return document.getElementById(id);
  }

  function isConfigured() {
    return Boolean(state.settings.apiUrl && state.settings.token);
  }

  function nextTimestamp(previous) {
    return Math.max(Date.now(), (Number(previous) || 0) + 1);
  }

  function plural(count, one, few, many) {
    var mod10 = count % 10;
    var mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }

  function formatTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch (err) {
      return '';
    }
  }

  function formatDateTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleString('ru-RU', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (err) {
      return '';
    }
  }

  function formatSyncTime(timestamp) {
    if (!timestamp) return '';
    var sameDay = new Date(timestamp).toDateString() === new Date().toDateString();
    return sameDay ? formatTime(timestamp) : formatDateTime(timestamp);
  }

  function delay(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  function findTask(id) {
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === id) return state.tasks[i];
    }
    return null;
  }

  function parseHex(hex) {
    var match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!match) return [0, 0, 0];
    var value = parseInt(match[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  /** Смешивает цвет с target ('#ffffff' или '#000000') на долю ratio (0…1). */
  function mixHex(hex, target, ratio) {
    var from = parseHex(hex);
    var to = parseHex(target);
    var share = Math.min(1, Math.max(0, Number(ratio) || 0));
    var mixed = from.map(function (channel, index) {
      return Math.round(channel + (to[index] - channel) * share);
    });
    return '#' + mixed.map(function (channel) {
      return channel.toString(16).padStart(2, '0');
    }).join('');
  }

  function luminance(hex) {
    var rgb = parseHex(hex).map(function (channel) {
      var value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }

  function prefersDark() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function isDarkTheme(theme) {
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    return prefersDark();
  }

  /**
   * Подбирает цвет текста/ссылок поверх фона так, чтобы он оставался читаемым.
   * Для светлой темы затемняет акцент, для тёмной — осветляет.
   */
  function readableText(base, dark) {
    var ratio = dark ? 0.34 : 0.26;
    var target = dark ? 0.62 : 0.22;
    var text = mixHex(base, dark ? '#ffffff' : '#000000', ratio);

    for (var i = 0; i < 6; i++) {
      if (dark ? luminance(text) >= target : luminance(text) <= target) break;
      ratio += 0.12;
      text = mixHex(base, dark ? '#ffffff' : '#000000', ratio);
    }
    return text;
  }

  /**
   * Рассчитывает оттенки акцента для темы.
   * В тёмной теме «чёрный» становится светло-серым, иначе кнопки были бы невидимы.
   */
  function accentPalette(key, theme) {
    var dark = isDarkTheme(theme);
    var base = Store.accentHex(key) || Store.accentHex('blue');
    if (dark && key === 'black') {
      base = '#e5e7eb';
    } else if (dark && luminance(base) < 0.25) {
      // Тёмные цвета на тёмном фоне делаем чуть светлее, иначе кнопки тускнеют.
      base = mixHex(base, '#ffffff', 0.18);
    }

    return {
      base: base,
      light: mixHex(base, '#ffffff', dark ? 0.26 : 0.18),
      text: readableText(base, dark),
      on: luminance(base) > 0.45 ? '#111827' : '#ffffff'
    };
  }

  function applyAccent(key, theme) {
    var palette = accentPalette(key, theme);
    var style = document.documentElement.style;
    style.setProperty('--accent', palette.base);
    style.setProperty('--accent-2', palette.light);
    style.setProperty('--accent-text', palette.text);
    style.setProperty('--on-accent', palette.on);
  }

  function applyTheme(theme) {
    var value = theme === 'light' || theme === 'dark' ? theme : 'auto';
    document.documentElement.setAttribute('data-theme', value);
    applyAccent(state.settings.accent, value);
  }

  function showDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', 'open');
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Запуск                                                             */
  /* ------------------------------------------------------------------ */

  function init() {
    cacheElements();
    renderColorSwatches();
    renderIconPicker();
    renderAccentSwatches();
    applyTheme(state.settings.theme);
    state.tasks = Store.loadTasks();
    bindEvents();
    renderAll();
    registerServiceWorker();
    refreshPendingPhotoCounts();

    if (isConfigured()) {
      window.setTimeout(function () { sync({ reason: 'start' }); }, 400);
    }

    state.intervalId = window.setInterval(function () {
      if (document.visibilityState === 'visible') sync({ reason: 'timer' });
    }, SYNC_INTERVAL);
  }

  function cacheElements() {
    els.addForm = $('addForm');
    els.newTitle = $('newTitle');
    els.taskList = $('taskList');
    els.emptyState = $('emptyState');
    els.emptyText = $('emptyText');
    els.searchInput = $('searchInput');
    els.chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
    els.counts = {
      all: document.querySelector('[data-count="all"]'),
      active: document.querySelector('[data-count="active"]'),
      done: document.querySelector('[data-count="done"]')
    };
    els.statusBtn = $('statusBtn');
    els.statusText = $('statusText');
    els.summary = $('summary');
    els.syncNowBtn = $('syncNowBtn');
    els.settingsBtn = $('settingsBtn');
    els.setupBanner = $('setupBanner');
    els.setupBtn = $('setupBtn');
    els.errorBanner = $('errorBanner');
    els.errorText = $('errorText');
    els.errorFixBtn = $('errorFixBtn');
    els.editDialog = $('editDialog');
    els.editForm = $('editForm');
    els.editTitle = $('editTitle');
    els.editNotes = $('editNotes');
    els.editDue = $('editDue');
    els.editDueTime = $('editDueTime');
    els.editPriority = $('editPriority');
    els.editHint = $('editHint');
    els.deleteTaskBtn = $('deleteTaskBtn');
    els.editSaveBtn = $('editSaveBtn');
    els.editHeading = $('editHeading');
    els.colorRow = $('colorRow');
    els.iconRow = $('iconRow');
    els.duePresets = Array.prototype.slice.call(document.querySelectorAll('.due-presets button'));
    els.subtaskList = $('subtaskList');
    els.subtaskInput = $('subtaskInput');
    els.subtaskAddBtn = $('subtaskAddBtn');
    els.photoGrid = $('photoGrid');
    els.photoInput = $('photoInput');
    els.photoDialog = $('photoDialog');
    els.photoPreviewImg = $('photoPreviewImg');
    els.photoPreviewHint = $('photoPreviewHint');
    els.photoDownload = $('photoDownload');
    els.detailsBtn = $('detailsBtn');
    els.settingsDialog = $('settingsDialog');
    els.settingsForm = $('settingsForm');
    els.apiUrlInput = $('apiUrlInput');
    els.tokenInput = $('tokenInput');
    els.themeInput = $('themeInput');
    els.accentRow = $('accentRow');
    els.settingsHint = $('settingsHint');
    els.testBtn = $('testBtn');
    els.toast = $('toast');
  }

  function bindEvents() {
    els.addForm.addEventListener('submit', onAddSubmit);

    els.taskList.addEventListener('click', function (event) {
      var target = event.target.closest ? event.target.closest('[data-action]') : null;
      if (!target || !els.taskList.contains(target)) return;
      var item = target.closest('.task');
      if (!item) return;
      var id = item.getAttribute('data-id');
      var action = target.getAttribute('data-action');
      if (action === 'toggle') toggleTask(id);
      else if (action === 'subtask-toggle') toggleSubtask(id, target.getAttribute('data-subtask-id'));
      else if (action === 'edit') openTaskDialog(id);
    });

    els.chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        setFilter(chip.getAttribute('data-filter'));
      });
    });

    els.searchInput.addEventListener('input', function () {
      state.query = els.searchInput.value;
      renderList();
    });

    els.statusBtn.addEventListener('click', function () {
      if (!isConfigured()) openSettingsDialog();
      else sync({ reason: 'manual', manual: true });
    });
    els.syncNowBtn.addEventListener('click', function () {
      if (!isConfigured()) openSettingsDialog();
      else sync({ reason: 'manual', manual: true });
    });
    els.settingsBtn.addEventListener('click', openSettingsDialog);
    els.setupBtn.addEventListener('click', openSettingsDialog);
    els.errorFixBtn.addEventListener('click', openSettingsDialog);
    els.detailsBtn.addEventListener('click', function () {
      openTaskDialog(null, els.newTitle.value.trim());
    });

    els.editForm.addEventListener('submit', onEditSubmit);
    els.deleteTaskBtn.addEventListener('click', onDeleteClick);
    els.subtaskAddBtn.addEventListener('click', addSubtaskFromInput);
    els.subtaskInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        addSubtaskFromInput();
      }
    });
    els.photoInput.addEventListener('change', onPhotosSelected);
    els.duePresets.forEach(function (button) {
      button.addEventListener('click', function () {
        applyDuePreset(button.getAttribute('data-due'));
      });
    });
    els.settingsForm.addEventListener('submit', onSettingsSubmit);
    els.testBtn.addEventListener('click', onTestConnection);
    els.themeInput.addEventListener('change', function () {
      applyTheme(els.themeInput.value);
      applyAccent(settingsAccent || state.settings.accent, els.themeInput.value);
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (btn) {
      btn.addEventListener('click', function () {
        var dialog = btn.closest('dialog');
        if (dialog) dialog.close();
      });
    });

    [els.editDialog, els.settingsDialog, els.photoDialog].forEach(function (dialog) {
      dialog.addEventListener('click', function (event) {
        if (event.target === dialog) dialog.close();
      });
    });

    els.settingsDialog.addEventListener('close', function () {
      settingsAccent = state.settings.accent;
      setSettingsAccent(settingsAccent, false);
      applyTheme(state.settings.theme);
    });
    els.editDialog.addEventListener('close', function () {
      cleanupEditorAfterClose();
    });

    window.addEventListener('online', function () {
      renderStatus();
      sync({ reason: 'online' });
    });
    window.addEventListener('offline', function () {
      renderStatus();
      renderSummary();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') sync({ reason: 'visible' });
    });
    window.addEventListener('storage', onStorageChange);

    if (window.matchMedia) {
      var schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
      var onSchemeChange = function () {
        if (state.settings.theme === 'auto') applyTheme('auto');
      };
      if (typeof schemeQuery.addEventListener === 'function') {
        schemeQuery.addEventListener('change', onSchemeChange);
      } else if (typeof schemeQuery.addListener === 'function') {
        schemeQuery.addListener(onSchemeChange);
      }
    }
  }

  function onStorageChange(event) {
    if (!event.key) return;
    if (event.key === Store.KEYS.tasks) {
      state.tasks = Store.loadTasks();
      renderAll();
    } else if (event.key === Store.KEYS.settings) {
      state.settings = Store.loadSettings();
      applyTheme(state.settings.theme);
      renderAll();
    } else if (event.key === Store.KEYS.meta) {
      state.lastSyncAt = Store.getMeta().lastSyncAt;
      renderSummary();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Отрисовка                                                          */
  /* ------------------------------------------------------------------ */

  function renderAll() {
    renderList();
    renderCounts();
    renderSummary();
    renderStatus();
    renderBanners();
  }

  function visibleTasks() {
    var query = state.query.trim().toLowerCase();
    return state.tasks
      .filter(function (task) { return !task.deletedAt; })
      .filter(function (task) {
        if (state.filter === 'done') return task.done;
        if (state.filter === 'active') return !task.done;
        return true;
      })
      .filter(function (task) {
        if (!query) return true;
        return task.title.toLowerCase().indexOf(query) !== -1 ||
          (task.notes || '').toLowerCase().indexOf(query) !== -1;
      })
      .sort(Store.compareTasks);
  }

  function renderList() {
    var list = visibleTasks();
    els.taskList.textContent = '';

    var fragment = document.createDocumentFragment();
    list.forEach(function (task) {
      fragment.appendChild(createTaskElement(task));
    });
    els.taskList.appendChild(fragment);

    var hasAny = state.tasks.some(function (task) { return !task.deletedAt; });
    els.emptyState.hidden = list.length > 0;
    els.emptyText.textContent = emptyText(hasAny);
  }

  function emptyText(hasAny) {
    if (state.query.trim()) return 'Ничего не найдено.';
    if (!hasAny) return 'Пока пусто. Добавьте первую задачу — она появится на всех устройствах.';
    if (state.filter === 'active') return 'Все задачи выполнены. Отдыхайте!';
    if (state.filter === 'done') return 'Выполненных задач пока нет.';
    return 'Здесь появятся ваши задачи.';
  }

  function createTaskElement(task) {
    var li = document.createElement('li');
    li.className = 'task' + (task.done ? ' is-done' : '');
    li.setAttribute('data-id', task.id);

    var colorHex = task.color ? Store.colorHex(task.color) : '';
    if (colorHex) {
      li.classList.add('has-color');
      li.style.setProperty('--task-color', colorHex);
    }

    var check = document.createElement('button');
    check.type = 'button';
    check.className = 'check';
    check.setAttribute('data-action', 'toggle');
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', task.done ? 'true' : 'false');
    check.setAttribute('aria-label', task.done ? 'Вернуть в активные' : 'Отметить выполненной');
    check.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"></path></svg>';

    var body = document.createElement('button');
    body.type = 'button';
    body.className = 'task-body';
    body.setAttribute('data-action', 'edit');
    body.setAttribute('aria-label', 'Открыть задачу: ' + task.title);

    var titleLine = document.createElement('span');
    titleLine.className = 'task-title-line';

    if (task.icon) {
      var icon = document.createElement('span');
      icon.className = 'task-icon';
      icon.textContent = task.icon;
      icon.setAttribute('aria-hidden', 'true');
      titleLine.appendChild(icon);
    }

    var title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;
    titleLine.appendChild(title);
    body.appendChild(titleLine);

    var meta = document.createElement('span');
    meta.className = 'task-meta';

    if (task.due) {
      var due = document.createElement('span');
      due.className = 'meta-item due' + (isOverdue(task) ? ' is-overdue' : '');
      due.textContent = dueLabel(task.due, task.dueTime);
      meta.appendChild(due);
    }

    if (task.priority === 'high') {
      var priority = document.createElement('span');
      priority.className = 'meta-item high';
      priority.textContent = 'важное';
      meta.appendChild(priority);
    }

    if (task.subtasks && task.subtasks.length) {
      var doneSubtasks = task.subtasks.filter(function (item) { return item.done; }).length;
      var subtaskMeta = document.createElement('span');
      subtaskMeta.className = 'meta-item subtasks' + (doneSubtasks === task.subtasks.length ? ' is-complete' : '');
      subtaskMeta.textContent = '✓ ' + doneSubtasks + '/' + task.subtasks.length;
      meta.appendChild(subtaskMeta);
    }

    var pendingPhotos = state.pendingPhotoCounts[task.id] || 0;
    var photoTotal = (task.photos ? task.photos.length : 0) + pendingPhotos;
    if (photoTotal) {
      var photoMeta = document.createElement('span');
      photoMeta.className = 'meta-item photos' + (pendingPhotos ? ' is-pending' : '');
      photoMeta.textContent = '📷 ' + photoTotal;
      photoMeta.title = pendingPhotos ? 'Часть фото ещё ждёт отправки' : 'Фотографии';
      meta.appendChild(photoMeta);
    }

    if (task.notes) {
      var notes = document.createElement('span');
      notes.className = 'meta-item notes';
      notes.textContent = task.notes.replace(/\s+/g, ' ').trim();
      meta.appendChild(notes);
    }

    if (meta.childNodes.length) body.appendChild(meta);

    if (task.subtasks && task.subtasks.length) {
      body.appendChild(createTaskSubtasks(task));
    }

    if (photoTotal) {
      var thumb = createTaskPhoto(task);
      if (thumb) body.appendChild(thumb);
    }

    var edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'task-edit';
    edit.setAttribute('data-action', 'edit');
    edit.setAttribute('aria-label', 'Редактировать задачу');
    edit.title = 'Редактировать';
    edit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';

    li.appendChild(check);
    li.appendChild(body);
    li.appendChild(edit);
    return li;
  }

  // Подзадачи под задачей в списке: текст открывает задачу, кружок отмечает подзадачу.
  function createTaskSubtasks(task) {
    var wrap = document.createElement('span');
    wrap.className = 'task-subtasks';

    task.subtasks.forEach(function (subtask) {
      var row = document.createElement('span');
      row.className = 'task-subtask' + (subtask.done ? ' is-done' : '');

      var mark = document.createElement('span');
      mark.className = 'task-subtask-mark';
      mark.setAttribute('role', 'checkbox');
      mark.setAttribute('aria-checked', subtask.done ? 'true' : 'false');
      mark.setAttribute('aria-label', subtask.done ? 'Вернуть подзадачу в работу' : 'Отметить подзадачу выполненной');
      mark.setAttribute('title', subtask.done ? 'Вернуть в работу' : 'Отметить выполненной');
      mark.setAttribute('data-action', 'subtask-toggle');
      mark.setAttribute('data-subtask-id', subtask.id);
      mark.textContent = '✓';

      var text = document.createElement('span');
      text.className = 'task-subtask-text';
      text.textContent = subtask.text;

      row.appendChild(mark);
      row.appendChild(text);
      wrap.appendChild(row);
    });

    return wrap;
  }

  // Первая фотография задачи в виде миниатюры (отправленная или ещё ожидающая).
  function createTaskPhoto(task) {
    var wrap = document.createElement('span');
    wrap.className = 'task-photo';

    var img = document.createElement('img');
    img.className = 'task-thumb';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    wrap.appendChild(img);

    resolveTaskThumb(task, img);
    return wrap;
  }

  function resolveTaskThumb(task, img) {
    function apply(dataUrl) {
      if (dataUrl && img.isConnected) img.src = dataUrl;
    }

    var photo = task.photos && task.photos.length ? task.photos[0] : null;
    var source = photo
      ? resolvePhotoDataUrl(task, photo)
      : Photos.listPending(task.id).then(function (records) {
        var record = records && records[0];
        return record && record.dataUrl ? record.dataUrl : '';
      });

    source.then(apply).catch(function () {});
  }

  function resolvePhotoDataUrl(task, photo) {
    return Photos.get(photo.id).then(function (record) {
      if (record && record.dataUrl) return record.dataUrl;
      if (thumbInflight[photo.id]) return thumbInflight[photo.id];
      if (!isConfigured() || !navigator.onLine) return '';

      thumbInflight[photo.id] = Api.photoGet(state.settings, photo.id).then(function (result) {
        var dataUrl = 'data:' + (result.mime || photo.mime || 'image/jpeg') + ';base64,' + result.data;
        return Photos.put({
          id: photo.id,
          taskId: task.id,
          dataUrl: dataUrl,
          mime: result.mime || photo.mime,
          width: photo.width,
          height: photo.height,
          size: photo.size,
          createdAt: photo.createdAt,
          pending: false
        }).then(function () { return dataUrl; });
      }).then(function (dataUrl) {
        delete thumbInflight[photo.id];
        return dataUrl;
      }, function (err) {
        delete thumbInflight[photo.id];
        throw err;
      });

      return thumbInflight[photo.id];
    });
  }

  function parseDueDate(value) {
    var parts = String(value).split('-');
    if (parts.length !== 3) return null;
    var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return isNaN(date.getTime()) ? null : date;
  }

  function parseDueTime(value) {
    var match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
    return match ? { hours: Number(match[1]), minutes: Number(match[2]) } : null;
  }

  function formatClock(value) {
    var time = parseDueTime(value);
    if (!time) return '';
    return String(time.hours).padStart(2, '0') + ':' + String(time.minutes).padStart(2, '0');
  }

  function startOfToday() {
    var now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function isOverdue(task) {
    if (!task.due || task.done) return false;
    var due = parseDueDate(task.due);
    if (!due) return false;
    var time = parseDueTime(task.dueTime);
    if (time) {
      due.setHours(time.hours, time.minutes, 0, 0);
      return due.getTime() < Date.now();
    }
    return due < startOfToday();
  }

  function dueLabel(value, time) {
    var due = parseDueDate(value);
    if (!due) return '';
    var clock = formatClock(time);
    var diff = Math.round((due - startOfToday()) / 86400000);
    var text;
    if (diff === 0) text = 'сегодня';
    else if (diff === 1) text = 'завтра';
    else if (diff === -1) text = 'вчера';
    else if (diff === 2) text = 'послезавтра';
    else if (diff < 0) {
      var daysPast = Math.abs(diff);
      text = 'просрочено на ' + daysPast + ' ' + plural(daysPast, 'день', 'дня', 'дней');
    } else if (diff < 7) {
      text = 'через ' + diff + ' ' + plural(diff, 'день', 'дня', 'дней');
    } else {
      try {
        text = due.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
      } catch (err) {
        text = String(value);
      }
    }
    return clock ? text + ', ' + clock : text;
  }

  function countTasks() {
    var active = 0;
    var done = 0;
    state.tasks.forEach(function (task) {
      if (task.deletedAt) return;
      if (task.done) done++;
      else active++;
    });
    return { active: active, done: done, all: active + done };
  }

  function renderCounts() {
    var counts = countTasks();
    els.counts.all.textContent = String(counts.all);
    els.counts.active.textContent = String(counts.active);
    els.counts.done.textContent = String(counts.done);

    els.chips.forEach(function (chip) {
      chip.classList.toggle('is-active', chip.getAttribute('data-filter') === state.filter);
    });
  }

  function pendingCount() {
    if (!isConfigured()) return 0;
    var count = 0;
    state.tasks.forEach(function (task) {
      if (!task.deletedAt && task.updatedAt > state.lastSyncAt) count++;
    });
    return count;
  }

  function renderSummary() {
    var counts = countTasks();
    var parts = [counts.active + ' ' + plural(counts.active, 'активная', 'активные', 'активных')];
    if (counts.done) {
      parts.push(counts.done + ' ' + plural(counts.done, 'выполнена', 'выполнены', 'выполнено'));
    }

    if (isConfigured()) {
      var pending = pendingCount();
      if (pending) {
        parts.push('к отправке: ' + pending);
      } else if (state.lastSyncAt) {
        parts.push('синхр. в ' + formatSyncTime(state.lastSyncAt));
      }
    } else {
      parts.push('без синхронизации');
    }

    var pendingPhotos = 0;
    Object.keys(state.pendingPhotoCounts).forEach(function (taskId) {
      pendingPhotos += state.pendingPhotoCounts[taskId];
    });
    if (pendingPhotos) parts.push('фото к отправке: ' + pendingPhotos);

    els.summary.textContent = parts.join(' · ');
  }

  function renderStatus() {
    var kind = 'idle';
    var text = 'Готово к работе';
    var title = 'Синхронизировать сейчас';

    if (!isConfigured()) {
      kind = 'local';
      text = 'Только это устройство';
      title = 'Синхронизация не настроена. Нажмите, чтобы настроить.';
    } else if (!navigator.onLine) {
      kind = 'offline';
      text = 'Офлайн';
      title = 'Нет сети. Изменения сохранятся и отправятся позже.';
    } else if (state.syncing) {
      kind = 'syncing';
      text = 'Синхронизация…';
      title = 'Идёт обмен данными с Google Таблицей';
    } else if (state.syncKind === 'error') {
      kind = 'error';
      text = 'Ошибка';
      title = state.syncError || 'Не удалось синхронизировать';
    } else if (state.syncKind === 'synced') {
      kind = 'synced';
      text = 'Синхронизировано';
      title = state.lastSyncAt ? 'Последняя синхронизация: ' + formatDateTime(state.lastSyncAt) : 'Данные синхронизированы';
    }

    els.statusBtn.className = 'status is-' + kind;
    els.statusText.textContent = text;
    els.statusBtn.title = title;
  }

  function renderBanners() {
    els.setupBanner.hidden = isConfigured();
    var showError = isConfigured() && state.syncKind === 'error' && Boolean(state.syncError);
    els.errorBanner.hidden = !showError;
    if (showError) els.errorText.textContent = state.syncError;
  }

  function setFilter(filter) {
    if (['all', 'active', 'done'].indexOf(filter) === -1) return;
    state.filter = filter;
    renderList();
    renderCounts();
  }

  /* ------------------------------------------------------------------ */
  /*  Синхронизация                                                      */
  /* ------------------------------------------------------------------ */

  function scheduleSync() {
    if (!isConfigured()) return;
    window.clearTimeout(state.pushTimer);
    state.pushTimer = window.setTimeout(function () {
      sync({ reason: 'change' });
    }, PUSH_DELAY);
  }

  function setSyncKind(kind, message) {
    state.syncKind = kind;
    state.syncError = message || '';
    renderStatus();
    renderBanners();
    renderSummary();
  }

  function commitTasks(items) {
    state.tasks = items;
    Store.saveTasks(state.tasks);
    renderAll();
  }

  async function sync(options) {
    options = options || {};

    if (!isConfigured()) {
      if (options.manual) openSettingsDialog();
      return;
    }
    if (state.syncing) {
      state.queued = true;
      return;
    }
    if (!navigator.onLine) {
      setSyncKind('offline');
      if (options.manual) showToast('Нет интернета. Изменения сохранены на устройстве.', 'error');
      return;
    }

    state.syncing = true;
    setSyncKind('syncing');

    try {
      // 0. Досылаем фотографии, которые ждут отправки.
      await flushPendingPhotos();

      // 1. Забираем серверную версию и сливаем со своей.
      var remote = await Api.pull(state.settings);

      var merged = Store.merge(state.tasks, remote);
      commitTasks(merged.items);

      // 2. Отправляем только то, что наше и новее серверного.
      if (merged.changed.length) {
        var response = await Api.push(state.settings, merged.changed);

        if (response && Array.isArray(response.items)) {
          commitTasks(Store.merge(state.tasks, response.items).items);
        } else {
          // Ответ POST не удалось прочитать (CORS) — проверяем результат обычным GET.
          await delay(700);
          var verified = Store.merge(state.tasks, await Api.pull(state.settings));
          commitTasks(verified.items);
          if (verified.changed.length) {
            throw new Error('Изменения не дошли до Google Таблицы. Проверьте доступ «Все» (Anyone) и токен.');
          }
        }
      }

      state.lastSyncAt = Date.now();
      Store.updateMeta({ lastSyncAt: state.lastSyncAt });
      setSyncKind('synced');

      if (options.manual) showToast('Синхронизировано', 'ok');
    } catch (err) {
      var message = (err && err.message) || 'Не удалось синхронизировать';
      if (err && err.code === 'not_configured') {
        setSyncKind('idle');
      } else {
        setSyncKind('error', message);
        if (options.manual) showToast(message, 'error');
        if (window.console) console.warn('[sync]', err);
      }
    } finally {
      state.syncing = false;
      renderStatus();
      renderSummary();

      if (state.queued) {
        state.queued = false;
        window.setTimeout(function () { sync({ reason: 'queued' }); }, 1200);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Изменение задач                                                    */
  /* ------------------------------------------------------------------ */

  function persistTasks() {
    Store.saveTasks(state.tasks);
  }

  function onAddSubmit(event) {
    event.preventDefault();
    var title = els.newTitle.value.trim();
    if (!title) {
      els.newTitle.focus();
      return;
    }
    addTask(title);
    els.newTitle.value = '';
    els.newTitle.focus();
  }

  function addTask(title) {
    var now = Date.now();
    state.tasks = state.tasks.concat({
      id: Store.uid(),
      title: title.slice(0, 500),
      notes: '',
      done: false,
      priority: 'normal',
      due: '',
      dueTime: '',
      color: '',
      icon: '',
      subtasks: [],
      photos: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: 0
    });
    persistTasks();
    renderAll();
    scheduleSync();
  }

  function toggleTask(id) {
    state.tasks = state.tasks.map(function (task) {
      if (task.id !== id) return task;
      return Object.assign({}, task, {
        done: !task.done,
        updatedAt: nextTimestamp(task.updatedAt)
      });
    });
    persistTasks();
    renderAll();
    scheduleSync();
  }

  function toggleSubtask(taskId, subtaskId) {
    if (!taskId || !subtaskId) return;

    state.tasks = state.tasks.map(function (task) {
      if (task.id !== taskId) return task;
      var subtasks = (task.subtasks || []).map(function (subtask) {
        if (subtask.id !== subtaskId) return subtask;
        return Object.assign({}, subtask, { done: !subtask.done });
      });
      return Object.assign({}, task, {
        subtasks: subtasks,
        updatedAt: nextTimestamp(task.updatedAt)
      });
    });
    persistTasks();
    renderAll();
    scheduleSync();
  }

  function updateTask(id, patch) {
    state.tasks = state.tasks.map(function (task) {
      if (task.id !== id) return task;
      return Object.assign({}, task, patch, {
        updatedAt: nextTimestamp(task.updatedAt)
      });
    });
    persistTasks();
    renderAll();
    scheduleSync();
  }

  function deleteTask(id) {
    var task = findTask(id);
    var photoIds = task && task.photos ? task.photos.map(function (photo) { return photo.id; }) : [];

    state.tasks = state.tasks.map(function (item) {
      if (item.id !== id) return item;
      var now = nextTimestamp(item.updatedAt);
      return Object.assign({}, item, { deletedAt: now, updatedAt: now });
    });
    persistTasks();
    renderAll();
    scheduleSync();

    if (photoIds.length) {
      Photos.removeMany(photoIds);
      if (isConfigured()) {
        Api.photoDelete(state.settings, photoIds).catch(function () {});
      }
    }

    Photos.listPending(id).then(function (records) {
      return Photos.removeMany(records.map(function (record) { return record.id; }));
    }).then(function () {
      refreshPendingPhotoCounts();
    }).catch(function () {});
  }

  /* ------------------------------------------------------------------ */
  /*  Диалог задачи                                                      */
  /* ------------------------------------------------------------------ */

  function isoFromDate(date) {
    var month = String(date.getMonth() + 1).padStart(2, '0');
    var day = String(date.getDate()).padStart(2, '0');
    return date.getFullYear() + '-' + month + '-' + day;
  }

  function applyDuePreset(kind) {
    if (!kind) {
      els.editDue.value = '';
      els.editDueTime.value = '';
      return;
    }
    var date = new Date();
    if (kind === 'tomorrow') date.setDate(date.getDate() + 1);
    else if (kind === 'week') date.setDate(date.getDate() + 7);
    els.editDue.value = isoFromDate(date);
  }

  function renderColorSwatches() {
    els.colorRow.textContent = '';

    var options = [{ key: '', label: 'Без цвета' }].concat(Store.COLORS.map(function (color) {
      return { key: color.key, label: color.label, hex: color.hex };
    }));

    options.forEach(function (option) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch' + (option.key ? '' : ' swatch-none');
      button.setAttribute('data-color', option.key);
      button.setAttribute('aria-label', option.label);
      button.setAttribute('aria-pressed', 'false');
      button.title = option.label;
      if (option.hex) button.style.setProperty('--swatch', option.hex);
      button.addEventListener('click', function () { setEditorColor(option.key); });
      els.colorRow.appendChild(button);
    });
  }

  function setEditorColor(color) {
    editor.color = Store.COLOR_KEYS.indexOf(color) >= 0 ? color : '';
    Array.prototype.forEach.call(els.colorRow.querySelectorAll('.swatch'), function (button) {
      var active = (button.getAttribute('data-color') || '') === editor.color;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function renderIconPicker() {
    els.iconRow.textContent = '';

    var options = [{ key: '', label: 'Без иконки' }].concat(Store.ICONS);
    options.forEach(function (option) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'icon-choice' + (option.key ? '' : ' icon-choice-none');
      button.setAttribute('data-icon', option.key);
      button.setAttribute('aria-label', option.label);
      button.setAttribute('aria-pressed', 'false');
      button.title = option.label;
      button.textContent = option.key || '—';
      button.addEventListener('click', function () { setEditorIcon(option.key); });
      els.iconRow.appendChild(button);
    });
  }

  function setEditorIcon(icon) {
    editor.icon = Store.ICON_KEYS.indexOf(icon) >= 0 ? icon : '';
    Array.prototype.forEach.call(els.iconRow.querySelectorAll('.icon-choice'), function (button) {
      var active = (button.getAttribute('data-icon') || '') === editor.icon;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  async function openTaskDialog(taskId, prefillTitle) {
    var task = taskId ? findTask(taskId) : null;
    if (taskId && !task) return;

    editor.generation += 1;
    var generation = editor.generation;

    editor.mode = task ? 'edit' : 'new';
    editor.taskId = task ? task.id : null;
    editor.draftId = task ? task.id : Store.uid();
    editor.color = task ? task.color || '' : '';
    editor.icon = task ? task.icon || '' : '';
    editor.subtasks = task ? task.subtasks.map(function (item) {
      return { id: item.id, text: item.text, done: item.done };
    }) : [];
    editor.photos = [];
    editor.removedPhotos = [];
    editor.addedPhotoIds = [];
    editor.saved = false;

    if (task) {
      els.editTitle.value = task.title;
      els.editNotes.value = task.notes || '';
      els.editDue.value = task.due || '';
      els.editDueTime.value = task.dueTime || '';
      els.editPriority.value = task.priority;

      task.photos.forEach(function (photo) {
        editor.photos.push({
          id: photo.id, mime: photo.mime, width: photo.width, height: photo.height,
          size: photo.size, createdAt: photo.createdAt,
          pending: false, loading: true, dataUrl: null
        });
      });
    } else {
      els.editTitle.value = prefillTitle || '';
      els.editNotes.value = '';
      els.editDue.value = '';
      els.editDueTime.value = '';
      els.editPriority.value = 'normal';
    }

    els.editHeading.textContent = task ? 'Задача' : 'Новая задача';
    els.editSaveBtn.textContent = task ? 'Сохранить' : 'Создать';
    els.deleteTaskBtn.hidden = !task;

    setEditorColor(editor.color);
    setEditorIcon(editor.icon);
    renderSubtasks();
    renderPhotos();

    if (task) {
      var info = ['создано: ' + formatDateTime(task.createdAt)];
      if (task.updatedAt && task.updatedAt !== task.createdAt) {
        info.push('изменено: ' + formatDateTime(task.updatedAt));
      }
      if (!isConfigured()) info.push('хранится только на этом устройстве');
      els.editHint.textContent = info.join(' · ');
    } else {
      els.editHint.textContent = isConfigured()
        ? 'После сохранения задача появится на всех устройствах.'
        : 'Синхронизация не настроена — задача останется на этом устройстве.';
    }

    showDialog(els.editDialog);
    window.setTimeout(function () {
      els.editTitle.focus();
      els.editTitle.select();
    }, 60);

    try {
      var pendingRecords = await Photos.listPending(editor.taskId || editor.draftId);
      if (generation !== editor.generation) return;
      pendingRecords.forEach(function (record) {
        var exists = editor.photos.some(function (photo) { return photo.id === record.id; });
        if (exists) return;
        editor.photos.push({
          id: record.id, mime: record.mime, width: record.width, height: record.height,
          size: record.size, createdAt: record.createdAt,
          pending: true, loading: false, dataUrl: record.dataUrl
        });
      });
      renderPhotos();
    } catch (err) {
      if (window.console) console.warn('[photos] Не удалось прочитать очередь', err);
    }

    loadEditorPhotos(generation);
  }

  function cleanupEditorAfterClose() {
    if (!editor.saved) {
      editor.addedPhotoIds.forEach(function (id) { Photos.remove(id); });
    }
    editor.addedPhotoIds = [];
    editor.saved = false;
    refreshPendingPhotoCounts();
  }

  function normalizedSubtasksFromEditor() {
    return editor.subtasks
      .map(function (item) {
        return {
          id: item.id,
          text: String(item.text || '').trim().slice(0, 300),
          done: Boolean(item.done)
        };
      })
      .filter(function (item) { return item.text; });
  }

  function editorPhotosForSync() {
    return editor.photos
      .filter(function (photo) { return !photo.pending; })
      .map(function (photo) {
        return {
          id: photo.id,
          mime: photo.mime,
          width: photo.width,
          height: photo.height,
          size: photo.size,
          createdAt: photo.createdAt
        };
      });
  }

  async function uploadEditorPhotos() {
    for (var i = 0; i < editor.photos.length; i++) {
      var photo = editor.photos[i];
      if (!photo.pending) continue;

      var record = await Photos.get(photo.id);
      if (!record) {
        photo.pending = false;
        continue;
      }
      if (!isConfigured() || !navigator.onLine) continue;

      try {
        await Api.photoSave(state.settings, Photos.uploadPayload(record));
        await Photos.markUploaded(photo.id);
        photo.pending = false;
        editor.addedPhotoIds = editor.addedPhotoIds.filter(function (id) { return id !== photo.id; });
      } catch (err) {
        if (window.console) console.warn('[photos] загрузка отложена', err);
      }
    }
  }

  function createTaskWithData(id, data) {
    var now = Date.now();
    state.tasks = state.tasks.concat(Object.assign({
      id: id,
      title: '',
      notes: '',
      done: false,
      priority: 'normal',
      due: '',
      dueTime: '',
      color: '',
      icon: '',
      subtasks: [],
      photos: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: 0
    }, data));
    persistTasks();
    renderAll();
    scheduleSync();
  }

  async function onEditSubmit(event) {
    event.preventDefault();
    if (els.editSaveBtn.disabled) return;

    var title = els.editTitle.value.trim();
    if (!title) {
      els.editTitle.focus();
      return;
    }

    els.editSaveBtn.disabled = true;
    els.editSaveBtn.textContent = 'Сохраняем…';

    try {
      await uploadEditorPhotos();

      var dueValue = els.editDue.value || '';
      var patch = {
        title: title.slice(0, 500),
        notes: els.editNotes.value.trim().slice(0, 5000),
        due: dueValue,
        dueTime: dueValue ? (els.editDueTime.value || '') : '',
        priority: els.editPriority.value === 'high' ? 'high' : 'normal',
        color: editor.color,
        icon: editor.icon,
        subtasks: normalizedSubtasksFromEditor(),
        photos: editorPhotosForSync()
      };

      if (editor.mode === 'edit') {
        updateTask(editor.taskId, patch);
      } else {
        createTaskWithData(editor.draftId, patch);
        if (els.newTitle.value.trim() === patch.title) els.newTitle.value = '';
      }

      editor.removedPhotos.forEach(function (id) {
        Photos.remove(id);
        if (isConfigured()) {
          Api.photoDelete(state.settings, [id]).catch(function () {});
        }
      });
      editor.removedPhotos = [];
      editor.saved = true;

      flushPendingPhotos();
      refreshPendingPhotoCounts();
      els.editDialog.close();
      showToast(editor.mode === 'edit' ? 'Сохранено' : 'Задача создана', 'ok');
    } finally {
      els.editSaveBtn.disabled = false;
      els.editSaveBtn.textContent = editor.mode === 'edit' ? 'Сохранить' : 'Создать';
    }
  }

  function onDeleteClick() {
    if (editor.mode === 'new' || !editor.taskId) {
      els.editDialog.close();
      return;
    }

    var task = findTask(editor.taskId);
    var name = task && task.title ? '«' + task.title + '»' : 'эту задачу';

    if (!window.confirm('Удалить ' + name + '? Задача исчезнет на всех устройствах.')) return;

    editor.saved = true;
    deleteTask(editor.taskId);
    els.editDialog.close();
    showToast('Удалено', 'ok');
  }

  /* ------------------------------------------------------------------ */
  /*  Подзадачи и фотографии                                             */
  /* ------------------------------------------------------------------ */

  function renderSubtasks() {
    els.subtaskList.textContent = '';

    if (!editor.subtasks.length) {
      var empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'Подзадач пока нет.';
      els.subtaskList.appendChild(empty);
      return;
    }

    editor.subtasks.forEach(function (subtask) {
      var row = document.createElement('div');
      row.className = 'subtask-row' + (subtask.done ? ' is-done' : '');

      var check = document.createElement('button');
      check.type = 'button';
      check.className = 'subtask-check';
      check.setAttribute('role', 'checkbox');
      check.setAttribute('aria-checked', subtask.done ? 'true' : 'false');
      check.setAttribute('aria-label', subtask.done ? 'Вернуть в работу' : 'Отметить подзадачу выполненной');
      check.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"></path></svg>';
      check.addEventListener('click', function () {
        subtask.done = !subtask.done;
        renderSubtasks();
      });

      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'subtask-input';
      input.maxLength = 300;
      input.value = subtask.text;
      input.setAttribute('aria-label', 'Текст подзадачи');
      input.addEventListener('input', function () { subtask.text = input.value; });

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'subtask-remove';
      remove.setAttribute('aria-label', 'Удалить подзадачу');
      remove.textContent = '×';
      remove.addEventListener('click', function () {
        editor.subtasks = editor.subtasks.filter(function (item) { return item.id !== subtask.id; });
        renderSubtasks();
      });

      row.appendChild(check);
      row.appendChild(input);
      row.appendChild(remove);
      els.subtaskList.appendChild(row);
    });
  }

  function addSubtaskFromInput() {
    var text = els.subtaskInput.value.trim();
    if (!text) {
      els.subtaskInput.focus();
      return;
    }
    if (editor.subtasks.length >= 100) {
      showToast('К одной задаче можно добавить не больше 100 подзадач', 'error');
      return;
    }

    editor.subtasks.push({ id: Store.uid().slice(0, 24), text: text.slice(0, 300), done: false });
    els.subtaskInput.value = '';
    renderSubtasks();
    els.subtaskInput.focus();
  }

  function renderPhotos() {
    els.photoGrid.textContent = '';

    if (!editor.photos.length) {
      var empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'Фотографий пока нет.';
      els.photoGrid.appendChild(empty);
      return;
    }

    editor.photos.forEach(function (photo) {
      var tile = document.createElement('div');
      tile.className = 'photo-tile' + (photo.pending ? ' is-pending' : '');

      var preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'photo-preview';
      preview.setAttribute('aria-label', 'Открыть фото');

      if (photo.dataUrl) {
        var image = document.createElement('img');
        image.src = photo.dataUrl;
        image.alt = '';
        preview.appendChild(image);
      } else {
        var skeleton = document.createElement('span');
        skeleton.className = 'photo-skeleton';
        skeleton.textContent = photo.loading ? '…' : 'нет фото';
        preview.appendChild(skeleton);
      }
      preview.addEventListener('click', function () { openPhotoPreview(photo); });

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'photo-remove';
      remove.setAttribute('aria-label', 'Удалить фото');
      remove.textContent = '×';
      remove.addEventListener('click', function () { removeEditorPhoto(photo.id); });

      tile.appendChild(preview);
      tile.appendChild(remove);

      if (photo.pending) {
        var badge = document.createElement('span');
        badge.className = 'photo-badge';
        badge.textContent = 'ждёт';
        tile.appendChild(badge);
      }

      els.photoGrid.appendChild(tile);
    });
  }

  function loadEditorPhotos(generation) {
    editor.photos.forEach(function (photo) {
      if (photo.dataUrl || !photo.loading) return;

      Photos.get(photo.id).then(function (record) {
        if (generation !== editor.generation) return null;

        if (record && record.dataUrl) {
          photo.dataUrl = record.dataUrl;
          photo.loading = false;
          renderPhotos();
          return null;
        }

        if (!isConfigured() || !navigator.onLine) {
          photo.loading = false;
          renderPhotos();
          return null;
        }

        return Api.photoGet(state.settings, photo.id).then(function (result) {
          if (generation !== editor.generation) return;
          photo.dataUrl = 'data:' + (result.mime || photo.mime || 'image/jpeg') + ';base64,' + result.data;
          photo.loading = false;
          Photos.put({
            id: photo.id,
            taskId: editor.taskId || editor.draftId,
            dataUrl: photo.dataUrl,
            mime: photo.mime,
            width: photo.width,
            height: photo.height,
            size: photo.size,
            createdAt: photo.createdAt,
            pending: false
          });
          renderPhotos();
        });
      }).catch(function () {
        if (generation !== editor.generation) return;
        photo.loading = false;
        renderPhotos();
      });
    });
  }

  async function onPhotosSelected(event) {
    var files = Array.prototype.slice.call(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;

    var targetId = editor.taskId || editor.draftId;
    var limit = 12;

    if (editor.photos.length + files.length > limit) {
      showToast('К одной задаче можно прикрепить не больше ' + limit + ' фото', 'error');
      files = files.slice(0, Math.max(0, limit - editor.photos.length));
    }

    els.photoInput.disabled = true;
    for (var i = 0; i < files.length; i++) {
      try {
        var record = await Photos.addLocal(targetId, files[i]);
        editor.addedPhotoIds.push(record.id);
        editor.photos.push({
          id: record.id,
          mime: record.mime,
          width: record.width,
          height: record.height,
          size: record.size,
          createdAt: record.createdAt,
          pending: true,
          loading: false,
          dataUrl: record.dataUrl
        });
        renderPhotos();
      } catch (err) {
        showToast((err && err.message) || 'Не удалось добавить фото', 'error');
      }
    }
    els.photoInput.disabled = false;
  }

  function removeEditorPhoto(id) {
    var removed = null;

    editor.photos = editor.photos.filter(function (photo) {
      if (photo.id === id) {
        removed = photo;
        return false;
      }
      return true;
    });

    if (!removed) return;

    editor.addedPhotoIds = editor.addedPhotoIds.filter(function (item) { return item !== id; });
    if (removed.pending) {
      Photos.remove(id);
    } else {
      editor.removedPhotos.push(id);
    }
    renderPhotos();
  }

  async function openPhotoPreview(photo) {
    els.photoPreviewImg.removeAttribute('src');
    els.photoPreviewHint.textContent = 'Загружаем фото…';
    els.photoDownload.hidden = true;
    showDialog(els.photoDialog);

    var dataUrl = photo.dataUrl;
    if (!dataUrl) {
      var record = await Photos.get(photo.id);
      dataUrl = record && record.dataUrl;
    }

    if (!dataUrl && isConfigured() && navigator.onLine) {
      try {
        var result = await Api.photoGet(state.settings, photo.id);
        dataUrl = 'data:' + (result.mime || photo.mime || 'image/jpeg') + ';base64,' + result.data;
        await Photos.put({
          id: photo.id,
          taskId: editor.taskId || editor.draftId,
          dataUrl: dataUrl,
          mime: photo.mime,
          width: photo.width,
          height: photo.height,
          size: photo.size,
          createdAt: photo.createdAt,
          pending: false
        });
        photo.dataUrl = dataUrl;
        photo.loading = false;
        renderPhotos();
      } catch (err) {
        dataUrl = '';
      }
    }

    if (dataUrl) {
      els.photoPreviewImg.src = dataUrl;
      els.photoPreviewHint.textContent = '';
      els.photoDownload.href = dataUrl;
      els.photoDownload.hidden = false;
    } else {
      els.photoPreviewHint.textContent = 'Фото пока недоступно: оно загрузится, когда появится связь с таблицей.';
    }
  }

  async function flushPendingPhotos() {
    if (!isConfigured() || !navigator.onLine) return;

    var records = [];
    try {
      records = await Photos.listPending();
    } catch (err) {
      return;
    }

    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      try {
        await Api.photoSave(state.settings, Photos.uploadPayload(record));
        await Photos.markUploaded(record.id);

        var task = findTask(record.taskId);
        if (!task) {
          await Photos.remove(record.id);
          continue;
        }
        if (task.deletedAt) continue;

        var meta = Photos.metaOf(record);
        var exists = (task.photos || []).some(function (photo) { return photo.id === meta.id; });
        if (!exists) {
          updateTask(task.id, { photos: (task.photos || []).concat(meta) });
        }
      } catch (err) {
        if (window.console) console.warn('[photos] Не удалось отправить фото', err);
        break;
      }
    }

    if (records.length) refreshPendingPhotoCounts();
  }

  async function refreshPendingPhotoCounts() {
    try {
      var records = await Photos.listPending();
      var counts = {};
      records.forEach(function (record) {
        if (!record.taskId) return;
        counts[record.taskId] = (counts[record.taskId] || 0) + 1;
      });
      state.pendingPhotoCounts = counts;
      renderList();
      renderSummary();
    } catch (err) {
      if (window.console) console.warn('[photos] Не удалось посчитать очередь', err);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Настройки                                                          */
  /* ------------------------------------------------------------------ */

  function openSettingsDialog() {
    els.apiUrlInput.value = state.settings.apiUrl || '';
    els.tokenInput.value = state.settings.token || '';
    els.themeInput.value = state.settings.theme || 'auto';
    settingsAccent = state.settings.accent || 'blue';
    setSettingsAccent(settingsAccent, false);
    els.settingsHint.className = 'hint';
    els.settingsHint.textContent = isConfigured()
      ? 'Сейчас синхронизация включена. Изменения настроек применяются сразу после сохранения.'
      : 'Настройки хранятся только в этом браузере. На телефоне их нужно ввести отдельно (или зашить в js/config.js).';
    showDialog(els.settingsDialog);
  }

  function readSettingsForm() {
    return {
      apiUrl: els.apiUrlInput.value.trim(),
      token: els.tokenInput.value.trim(),
      theme: els.themeInput.value,
      accent: settingsAccent || state.settings.accent
    };
  }

  function renderAccentSwatches() {
    els.accentRow.textContent = '';

    Store.ACCENTS.forEach(function (accent) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch' + (accent.key === 'white' ? ' swatch-light' : '');
      button.setAttribute('data-accent', accent.key);
      button.setAttribute('aria-label', accent.label);
      button.setAttribute('aria-pressed', 'false');
      button.title = accent.label;
      button.style.setProperty('--swatch', accent.hex);
      button.addEventListener('click', function () { setSettingsAccent(accent.key, true); });
      els.accentRow.appendChild(button);
    });
  }

  function setSettingsAccent(key, preview) {
    settingsAccent = Store.ACCENT_KEYS.indexOf(key) >= 0 ? key : 'blue';
    Array.prototype.forEach.call(els.accentRow.querySelectorAll('.swatch'), function (button) {
      var active = button.getAttribute('data-accent') === settingsAccent;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (preview) applyAccent(settingsAccent, els.themeInput.value);
  }

  function onSettingsSubmit(event) {
    event.preventDefault();
    var next = readSettingsForm();

    if (next.apiUrl && !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/(exec|dev)(\?[^\s]*)?$/i.test(next.apiUrl)) {
      els.settingsHint.className = 'hint is-error';
      els.settingsHint.textContent = 'Адрес должен начинаться с https://script.google.com/macros/s/ и заканчиваться на /exec';
      return;
    }
    if (next.apiUrl && !next.token) {
      els.settingsHint.className = 'hint is-error';
      els.settingsHint.textContent = 'Добавьте токен — он должен совпадать с CFG.TOKEN в Code.gs.';
      return;
    }

    state.settings = Store.saveSettings(next);
    applyTheme(state.settings.theme);
    applyAccent(state.settings.accent, state.settings.theme);
    settingsAccent = state.settings.accent;
    state.syncKind = 'idle';
    state.syncError = '';
    els.settingsDialog.close();
    renderAll();

    if (isConfigured()) {
      sync({ reason: 'settings', manual: true });
    } else {
      showToast('Синхронизация отключена. Задачи хранятся на устройстве.', 'ok');
    }
  }

  async function onTestConnection() {
    var values = readSettingsForm();

    if (!values.apiUrl || !values.token) {
      els.settingsHint.className = 'hint is-error';
      els.settingsHint.textContent = 'Заполните URL и токен.';
      return;
    }

    els.testBtn.disabled = true;
    els.settingsHint.className = 'hint';
    els.settingsHint.textContent = 'Проверяем связь с Google Таблицей…';

    try {
      var info = await Api.ping(values);
      els.settingsHint.className = 'hint is-ok';
      els.settingsHint.textContent = 'Связь есть. Задач в таблице: ' + info.count + '.';
    } catch (err) {
      els.settingsHint.className = 'hint is-error';
      els.settingsHint.textContent = (err && err.message) || 'Не удалось подключиться.';
    } finally {
      els.testBtn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Уведомления и запуск                                               */
  /* ------------------------------------------------------------------ */

  function showToast(message, kind) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.className = 'toast is-visible' + (kind ? ' is-' + kind : '');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(function () {
      els.toast.className = 'toast';
    }, kind === 'error' ? 6000 : 3000);
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (location.protocol !== 'https:' && !isLocal) return;

    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function (err) {
        if (window.console) console.warn('[sw] Не удалось зарегистрировать service worker', err);
      });
    });
  }

  // Небольшой публичный интерфейс — удобно для отладки в консоли браузера.
  window.TasksApp = {
    sync: function () { return sync({ reason: 'manual', manual: true }); },
    getState: function () { return state; },
    render: renderAll
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();






