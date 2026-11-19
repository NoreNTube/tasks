/**
 * Локальное хранилище задач и настроек (localStorage).
 * Здесь же — правила слияния записей, одинаковые с сервером (Code.gs).
 */
(function (global) {
  'use strict';

  var KEYS = {
    tasks: 'tasksync.tasks.v1',
    meta: 'tasksync.meta.v1',
    settings: 'tasksync.settings.v1'
  };

  var DEFAULT_SETTINGS = {
    apiUrl: '',
    token: '',
    theme: 'auto',
    accent: 'blue'
  };

  var PRIORITIES = ['normal', 'high'];

  var COLORS = [
    { key: 'blue', label: 'Синий', hex: '#3b82f6' },
    { key: 'green', label: 'Зелёный', hex: '#22c55e' },
    { key: 'yellow', label: 'Жёлтый', hex: '#eab308' },
    { key: 'orange', label: 'Оранжевый', hex: '#f97316' },
    { key: 'red', label: 'Красный', hex: '#ef4444' },
    { key: 'purple', label: 'Фиолетовый', hex: '#a855f7' },
    { key: 'pink', label: 'Розовый', hex: '#ec4899' },
    { key: 'gray', label: 'Серый', hex: '#64748b' }
  ];

  var COLOR_KEYS = COLORS.map(function (color) { return color.key; });

  // Встроенный набор иконок задачи. Эмодзи не требуют отдельных файлов
  // и одинаково выглядят на телефоне и компьютере.
  var ICONS = [
    { key: '📌', label: 'Кнопка' },
    { key: '📅', label: 'Календарь' },
    { key: '⏰', label: 'Время' },
    { key: '💰', label: 'Деньги' },
    { key: '🏠', label: 'Дом' },
    { key: '🛒', label: 'Покупки' },
    { key: '✈️', label: 'Поездка' },
    { key: '🚗', label: 'Машина' },
    { key: '🎁', label: 'Подарок' },
    { key: '🎓', label: 'Учёба' },
    { key: '📚', label: 'Книги' },
    { key: '🔧', label: 'Ремонт' },
    { key: '💡', label: 'Идея' },
    { key: '🔔', label: 'Напоминание' },
    { key: '📞', label: 'Звонок' },
    { key: '✉️', label: 'Письмо' },
    { key: '✍️', label: 'Запись' },
    { key: '🏋️', label: 'Тренировка' },
    { key: '🍎', label: 'Еда' },
    { key: '🌿', label: 'Здоровье' },
    { key: '🐶', label: 'Питомец' },
    { key: '⭐', label: 'Важное' },
    { key: '❤️', label: 'Личное' },
    { key: '✅', label: 'Готово' }
  ];

  var ICON_KEYS = ICONS.map(function (icon) { return icon.key; });

  // Акцентные цвета интерфейса (сохраняются отдельно на каждом устройстве).
  var ACCENTS = [
    { key: 'red', label: 'Красный', hex: '#ef4444' },
    { key: 'orange', label: 'Оранжевый', hex: '#f97316' },
    { key: 'yellow', label: 'Жёлтый', hex: '#eab308' },
    { key: 'green', label: 'Зелёный', hex: '#22c55e' },
    { key: 'blue', label: 'Синий', hex: '#2563eb' },
    { key: 'purple', label: 'Фиолетовый', hex: '#7c3aed' },
    { key: 'pink', label: 'Розовый', hex: '#db2777' },
    { key: 'black', label: 'Чёрный', hex: '#111827' },
    { key: 'white', label: 'Белый', hex: '#f8fafc' }
  ];

  var ACCENT_KEYS = ACCENTS.map(function (accent) { return accent.key; });

  function keyHex(list, key) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) return list[i].hex;
    }
    return '';
  }

  function colorHex(key) {
    return keyHex(COLORS, key);
  }

  function accentHex(key) {
    return keyHex(ACCENTS, key);
  }

  function iconLabel(key) {
    for (var i = 0; i < ICONS.length; i++) {
      if (ICONS[i].key === key) return ICONS[i].label;
    }
    return '';
  }

  function read(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (err) {
      console.warn('[storage] Не удалось прочитать', key, err);
      return fallback;
    }
  }

  function write(key, value) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn('[storage] Не удалось сохранить', key, err);
      return false;
    }
  }

  function uid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function num(value) {
    var n = Number(value);
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function parseArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      try {
        var parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        return [];
      }
    }
    return [];
  }

  function normalizeSubtasks(value) {
    var list = parseArray(value);
    var seen = {};
    var result = [];

    list.slice(0, 100).forEach(function (item, index) {
      if (!item || typeof item !== 'object') return;
      var text = String(item.text == null ? '' : item.text).trim().slice(0, 300);
      if (!text) return;

      var id = String(item.id == null ? '' : item.id).trim().slice(0, 100) || ('s-' + index);
      if (seen[id]) id = id + '-' + index;
      seen[id] = true;

      result.push({
        id: id,
        text: text,
        done: item.done === true || item.done === 'true' || item.done === 'TRUE' || item.done === 1 || item.done === '1'
      });
    });

    return result;
  }

  function normalizePhotos(value) {
    var list = parseArray(value);
    var seen = {};
    var result = [];

    list.slice(0, 20).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      var id = String(item.id == null ? '' : item.id).trim().slice(0, 100);
      if (!id || seen[id]) return;

      var mime = String(item.mime || 'image/jpeg').toLowerCase();
      if (mime.indexOf('image/') !== 0) mime = 'image/jpeg';
      seen[id] = true;

      result.push({
        id: id,
        mime: mime,
        width: num(item.width),
        height: num(item.height),
        size: num(item.size),
        createdAt: num(item.createdAt)
      });
    });

    return result;
  }

  /**
   * Приводит запись к единому виду. Возвращает null, если записи нет id.
   */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;

    var id = String(raw.id == null ? '' : raw.id).trim();
    if (!id) return null;

    var createdAt = num(raw.createdAt) || Date.now();
    var title = String(raw.title == null ? '' : raw.title).trim().slice(0, 500);

    return {
      id: id.slice(0, 100),
      title: title || 'Без названия',
      notes: String(raw.notes == null ? '' : raw.notes).slice(0, 5000),
      done: raw.done === true || raw.done === 'true' || raw.done === 'TRUE' || raw.done === 1 || raw.done === '1',
      priority: PRIORITIES.indexOf(String(raw.priority)) >= 0 ? String(raw.priority) : 'normal',
      due: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.due || '')) ? String(raw.due) : '',
      dueTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.dueTime || '')) ? String(raw.dueTime) : '',
      color: COLOR_KEYS.indexOf(String(raw.color || '')) >= 0 ? String(raw.color) : '',
      icon: ICON_KEYS.indexOf(String(raw.icon || '')) >= 0 ? String(raw.icon) : '',
      subtasks: normalizeSubtasks(raw.subtasks),
      photos: normalizePhotos(raw.photos),
      createdAt: createdAt,
      updatedAt: num(raw.updatedAt) || createdAt,
      deletedAt: num(raw.deletedAt)
    };
  }

  function stableKey(rec) {
    return JSON.stringify([
      rec.id, rec.title, rec.notes, rec.done,
      rec.priority, rec.due, rec.dueTime, rec.createdAt, rec.updatedAt, rec.deletedAt,
      rec.color, rec.icon, rec.subtasks, rec.photos
    ]);
  }

  /** Побеждает более свежая запись; при равенстве — детерминированный выбор. */
  function wins(a, b) {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
    return stableKey(a) > stableKey(b);
  }

  /**
   * Сливает локальные и серверные записи.
   * Возвращает { items, changed } — changed это записи, которые нужно отправить на сервер.
   */
  function merge(localItems, remoteItems) {
    var map = new Map();

    (remoteItems || []).forEach(function (raw) {
      var rec = normalize(raw);
      if (rec) map.set(rec.id, rec);
    });

    var changed = [];

    (localItems || []).forEach(function (raw) {
      var rec = normalize(raw);
      if (!rec) return;
      var current = map.get(rec.id);
      if (!current) {
        map.set(rec.id, rec);
        changed.push(rec);
        return;
      }
      if (wins(rec, current)) {
        map.set(rec.id, rec);
        changed.push(rec);
      }
    });

    return { items: Array.from(map.values()), changed: changed };
  }

  function compareTasks(a, b) {
    if (a.done !== b.done) return a.done ? 1 : -1;
    var pa = a.priority === 'high' ? 0 : 1;
    var pb = b.priority === 'high' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    var da = a.due ? a.due + ' ' + (a.dueTime || '00:00') : '9999-12-31 00:00';
    var db = b.due ? b.due + ' ' + (b.dueTime || '00:00') : '9999-12-31 00:00';
    if (da !== db) return da < db ? -1 : 1;
    return b.createdAt - a.createdAt;
  }

  function loadTasks() {
    var raw = read(KEYS.tasks, []);
    if (!Array.isArray(raw)) return [];
    var result = [];
    raw.forEach(function (item) {
      var rec = normalize(item);
      if (rec) result.push(rec);
    });
    return result;
  }

  function saveTasks(items) {
    var list = (items || []).map(normalize).filter(Boolean);
    return write(KEYS.tasks, list);
  }

  function getMeta() {
    var meta = read(KEYS.meta, {});
    return { lastSyncAt: num(meta.lastSyncAt) };
  }

  function updateMeta(patch) {
    var meta = Object.assign(getMeta(), patch || {});
    write(KEYS.meta, meta);
    return meta;
  }

  function resolveAccent(value, fallback) {
    var key = String(value == null ? '' : value);
    if (ACCENT_KEYS.indexOf(key) >= 0) return key;
    return ACCENT_KEYS.indexOf(fallback) >= 0 ? fallback : DEFAULT_SETTINGS.accent;
  }

  function loadSettings() {
    var fromConfig = global.APP_CONFIG || {};
    var saved = read(KEYS.settings, {});
    var settings = Object.assign({}, DEFAULT_SETTINGS, {
      apiUrl: String(fromConfig.apiUrl || '').trim(),
      token: String(fromConfig.token || '').trim()
    }, saved);

    settings.apiUrl = String(settings.apiUrl || '').trim();
    settings.token = String(settings.token || '').trim();
    if (['auto', 'light', 'dark'].indexOf(String(settings.theme)) === -1) {
      settings.theme = 'auto';
    }
    var savedAccent = saved && saved.accent != null ? saved.accent : String(fromConfig.accent || '');
    settings.accent = resolveAccent(savedAccent, DEFAULT_SETTINGS.accent);
    return settings;
  }

  function saveSettings(patch) {
    var next = Object.assign(loadSettings(), patch || {});
    next.apiUrl = String(next.apiUrl || '').trim();
    next.token = String(next.token || '').trim();
    next.accent = resolveAccent(next.accent, DEFAULT_SETTINGS.accent);
    write(KEYS.settings, next);
    return next;
  }

  global.AppStorage = {
    KEYS: KEYS,
    COLORS: COLORS,
    COLOR_KEYS: COLOR_KEYS,
    colorHex: colorHex,
    ICONS: ICONS,
    ICON_KEYS: ICON_KEYS,
    iconLabel: iconLabel,
    ACCENTS: ACCENTS,
    ACCENT_KEYS: ACCENT_KEYS,
    accentHex: accentHex,
    uid: uid,
    normalize: normalize,
    normalizeSubtasks: normalizeSubtasks,
    normalizePhotos: normalizePhotos,
    merge: merge,
    wins: wins,
    stableKey: stableKey,
    compareTasks: compareTasks,
    loadTasks: loadTasks,
    saveTasks: saveTasks,
    getMeta: getMeta,
    updateMeta: updateMeta,
    loadSettings: loadSettings,
    saveSettings: saveSettings
  };
})(window);
