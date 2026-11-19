/**
 * ==========================================================================
 *  СИНХРОНИЗАЦИЯ ЗАДАЧ С GOOGLE ТАБЛИЦЕЙ  —  Google Apps Script (backend)
 * ==========================================================================
 *
 *  ЧТО ДЕЛАТЬ (кратко):
 *   1. Создайте Google Таблицу (например «Задачи»).
 *   2. В таблице: Расширения → Apps Script.
 *   3. Удалите код в редакторе и вставьте этот файл целиком.
 *   4. В объекте CFG ниже поменяйте TOKEN на длинную случайную строку.
 *   5. Развернуть → Новое развертывание → тип «Веб-приложение»:
 *        • Запуск от имени: Я
 *        • Доступ: Все (Anyone)
 *      Скопируйте URL, который заканчивается на /exec.
 *   6. Этот URL и токен вставьте в приложении в «Настройках» (шестерёнка).
 *
 *  API (всё через JSON):
 *    GET  ?action=ping&token=...            → { ok, count, serverTime }
 *    GET  ?action=pull&token=...            → { ok, items: [...] }
 *    POST { action:"sync", token, items }   → { ok, items: [...] }  // LWW-мерж
 *    POST { action:"photoSave", token, photo }
 *    GET  ?action=photo&token=...&id=...    → { ok, photo:{...,data} }
 *    GET  ?action=photoInfo&token=...&id=...→ { ok, exists, chunks }
 *    POST { action:"photoDelete", token, ids }
 *
 *  Лист tasks:
 *    id | title | notes | done | priority | due | createdAt | updatedAt | deletedAt |
 *    color | icon | subtasks(JSON) | photos(JSON) | dueTime
 *
 *  Лист photos (файлы кусками base64, по 40 000 символов):
 *    id | taskId | createdAt | mime | width | height | size | chunkIndex | data
 * ==========================================================================
 */

var CFG = {
  // ОБЯЗАТЕЛЬНО замените на свой длинный секрет (30+ символов).
  // Этот же токен нужно ввести в настройках приложения на каждом устройстве.
  TOKEN: 'CHANGE_ME_на_длинный_секрет',

  // Имя листа внутри таблицы.
  SHEET_NAME: 'tasks',

  // Если скрипт создан НЕ внутри таблицы (не через «Расширения»),
  // впишите сюда ID таблицы из её URL: /spreadsheets/d/<ID>/edit
  SPREADSHEET_ID: '',

  // Предохранитель от случайной перезаписи огромного листа.
  MAX_ITEMS: 5000,

  // Лист для фотографий и размер одного «куска» base64 в ячейке.
  PHOTO_SHEET: 'photos',
  PHOTO_CHUNK: 40000,
  PHOTO_MAX_CHARS: 400000,

  VERSION: 4
};

// Порядок колонок на листе. Менять не нужно.
var COLUMNS = ['id', 'title', 'notes', 'done', 'priority', 'due', 'createdAt', 'updatedAt', 'deletedAt', 'color', 'icon', 'subtasks', 'photos', 'dueTime'];
var PHOTO_COLUMNS = ['id', 'taskId', 'createdAt', 'mime', 'width', 'height', 'size', 'chunkIndex', 'data'];
var COLORS = ['blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink', 'gray'];
var ICONS = [
  '📌', '📅', '⏰', '💰', '🏠', '🛒', '✈️', '🚗', '🎁', '🎓', '📚', '🔧',
  '💡', '🔔', '📞', '✉️', '✍️', '🏋️', '🍎', '🌿', '🐶', '⭐', '❤️', '✅'
];

/* --------------------------------------------------------------------------
 *  HTTP-точки входа
 * ------------------------------------------------------------------------ */

function doGet(e) {
  return handle_(e);
}

function doPost(e) {
  return handle_(e);
}

function handle_(e) {
  try {
    var params = (e && e.parameter) || {};
    var payload = readPayload_(e, params);
    var token = String(payload.token || params.token || '');

    if (!CFG.TOKEN || CFG.TOKEN === 'CHANGE_ME_на_длинный_секрет') {
      return json_({ ok: false, error: 'server_not_configured', message: 'В Code.gs не задан TOKEN.' });
    }
    if (!token || token !== CFG.TOKEN) {
      return json_({ ok: false, error: 'unauthorized', message: 'Неверный токен доступа.' });
    }

    var action = String(payload.action || params.action || 'pull');

    if (action === 'ping') {
      var all = readAll_();
      return json_({
        ok: true,
        action: 'ping',
        count: countActive_(all),
        total: all.length,
        serverTime: Date.now(),
        version: CFG.VERSION
      });
    }

    if (action === 'pull') {
      return json_({ ok: true, items: readAll_(), serverTime: Date.now(), version: CFG.VERSION });
    }

    if (action === 'photoSave') {
      return photoSave_(payload.photo);
    }

    if (action === 'photo' || action === 'photoGet') {
      return json_({ ok: true, photo: photoGet_(payload.id || params.id) });
    }

    if (action === 'photoInfo') {
      var photoInfo = photoInfo_(payload.id || params.id);
      return json_({
        ok: true,
        exists: Boolean(photoInfo),
        chunks: photoInfo ? photoInfo.chunks : 0,
        size: photoInfo ? photoInfo.size : 0
      });
    }

    if (action === 'photoDelete') {
      return photoDelete_(payload.ids);
    }

    if (action === 'sync') {
      var items = Array.isArray(payload.items) ? payload.items : [];
      if (items.length > CFG.MAX_ITEMS) {
        return json_({ ok: false, error: 'too_many', message: 'Слишком много записей за один запрос.' });
      }

      var lock = LockService.getScriptLock();
      if (!lock.tryLock(30000)) {
        return json_({ ok: false, error: 'busy', message: 'Таблица занята другой синхронизацией.' });
      }
      try {
        var merged = merge_(readAll_(), items);
        if (merged.changed > 0) writeAll_(merged.items);
        return json_({
          ok: true,
          items: merged.items,
          changed: merged.changed,
          serverTime: Date.now(),
          version: CFG.VERSION
        });
      } finally {
        lock.releaseLock();
      }
    }

    return json_({ ok: false, error: 'unknown_action', message: 'Неизвестное действие: ' + action });
  } catch (err) {
    return json_({
      ok: false,
      error: 'server_error',
      message: String((err && err.message) || err)
    });
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* --------------------------------------------------------------------------
 *  Разбор входящего запроса
 * ------------------------------------------------------------------------ */

function readPayload_(e, params) {
  // 1) JSON-тело. Клиент шлёт Content-Type: text/plain, чтобы браузер
  //    не делал CORS-preflight (Apps Script его не умеет обрабатывать).
  if (e && e.postData && e.postData.contents) {
    var body = e.postData.contents;
    try {
      var parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (ignore) { /* не JSON — пробуем form-urlencoded ниже */ }

    try {
      var form = {};
      body.split('&').forEach(function (pair) {
        var i = pair.indexOf('=');
        if (i > 0) {
          form[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
        }
      });
      if (form.payload) {
        try { return JSON.parse(form.payload); } catch (ignore2) { return form; }
      }
      if (Object.keys(form).length) return form;
    } catch (ignore3) { /* fallthrough */ }
  }

  // 2) ?payload=<json>
  if (params && params.payload) {
    try { return JSON.parse(params.payload); } catch (ignore4) { /* fallthrough */ }
  }

  // 3) Параметры URL
  return params || {};
}

/* --------------------------------------------------------------------------
 *  Работа с листом
 * ------------------------------------------------------------------------ */

function getSpreadsheet_() {
  var ss = null;
  if (CFG.SPREADSHEET_ID) {
    ss = SpreadsheetApp.openById(CFG.SPREADSHEET_ID);
  } else {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }
  if (!ss) {
    throw new Error('Не удалось открыть таблицу. Создайте скрипт через «Расширения → Apps Script» либо укажите SPREADSHEET_ID.');
  }
  return ss;
}

function getSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(CFG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CFG.SHEET_NAME);
  }
  ensureHeader_(sheet);
  return sheet;
}

function ensureHeader_(sheet) {
  var headerRange = sheet.getRange(1, 1, 1, COLUMNS.length);
  if (sheet.getLastRow() === 0) {
    headerRange.setValues([COLUMNS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return;
  }

  // Читаем столько заголовков, сколько реально есть на листе.
  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  var first = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (cell) {
    return String(cell == null ? '' : cell).trim();
  });

  // Пустые ячейки справа не считаем колонками.
  while (first.length && first[first.length - 1] === '') first.pop();

  var matches = first.length === COLUMNS.length && COLUMNS.every(function (column, index) {
    return first[index] === column;
  });
  if (matches) return;

  // Лист, созданный старой версией (9 или 12 колонок): его заголовки —
  // начало актуального списка. Дописываем только заголовки, данные не трогаем.
  var isPrefix = first.length < COLUMNS.length && first.every(function (column, index) {
    return column === COLUMNS[index];
  });

  if (isPrefix) {
    headerRange.setValues([COLUMNS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return;
  }

  throw new Error(
    'На листе «' + CFG.SHEET_NAME + '» уже есть данные с другими заголовками. ' +
    'Переименуйте лист или создайте новый лист «' + CFG.SHEET_NAME + '».'
  );
}

function readAll_() {
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).getValues();
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var items = [];

  for (var i = 0; i < values.length; i++) {
    if (!values[i][0]) continue;
    var rec = normalize_(rowToRecord_(values[i], tz));
    if (rec) items.push(rec);
  }
  return items;
}

function rowToRecord_(row, tz) {
  var obj = {};
  for (var i = 0; i < COLUMNS.length; i++) obj[COLUMNS[i]] = row[i];
  if (obj.due instanceof Date) {
    obj.due = Utilities.formatDate(obj.due, tz || 'UTC', 'yyyy-MM-dd');
  }
  return obj;
}

function writeAll_(items) {
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).clearContent();
  }
  if (!items.length) return;

  var rows = items.map(recordToRow_);
  var range = sheet.getRange(2, 1, rows.length, COLUMNS.length);
  // Всё пишем как текст: так даты и «TRUE» не превращаются в типы Sheets.
  range.setNumberFormat('@');
  range.setValues(rows);
}

function recordToRow_(rec) {
  return [
    rec.id,
    rec.title,
    rec.notes,
    rec.done ? 'TRUE' : '',
    rec.priority,
    rec.due,
    rec.createdAt,
    rec.updatedAt,
    rec.deletedAt || '',
    rec.color || '',
    rec.icon || '',
    rec.subtasks && rec.subtasks.length ? JSON.stringify(rec.subtasks) : '',
    rec.photos && rec.photos.length ? JSON.stringify(rec.photos) : '',
    rec.dueTime || ''
  ];
}

function countActive_(items) {
  return items.filter(function (r) { return !r.deletedAt; }).length;
}

/* --------------------------------------------------------------------------
 *  Слияние записей (Last-Write-Wins + детерминированный тай-брейк)
 *  base     — то, что уже лежит в таблице;
 *  incoming — записи, присланные клиентом;
 *  changed  — сколько клиентских записей реально применилось (их и вернём).
 * ------------------------------------------------------------------------ */

function merge_(base, incoming) {
  var map = {};
  var order = [];

  (base || []).forEach(function (raw) {
    var rec = normalize_(raw);
    if (!rec) return;
    if (!map[rec.id]) order.push(rec.id);
    map[rec.id] = rec;
  });

  var changed = 0;

  (incoming || []).forEach(function (raw) {
    var rec = normalize_(raw);
    if (!rec) return;
    var current = map[rec.id];
    if (!current || wins_(rec, current)) {
      if (!current) order.push(rec.id);
      map[rec.id] = rec;
      changed++;
    }
  });

  var items = order.map(function (id) { return map[id]; });
  items.sort(function (a, b) {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { items: items, changed: changed };
}

function wins_(a, b) {
  if ((a.updatedAt || 0) !== (b.updatedAt || 0)) return (a.updatedAt || 0) > (b.updatedAt || 0);
  return stableKey_(a) > stableKey_(b);
}

function stableKey_(rec) {
  return JSON.stringify([
    rec.id, rec.title, rec.notes, rec.done,
    rec.priority, rec.due, rec.dueTime, rec.createdAt, rec.updatedAt, rec.deletedAt,
    rec.color, rec.icon, rec.subtasks, rec.photos
  ]);
}

function numOrZero_(value) {
  var n = Number(value);
  return isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function parseArray_(value) {
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

function normalizeSubtasks_(value) {
  var seen = {};
  var result = [];

  parseArray_(value).slice(0, 100).forEach(function (item, index) {
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

function normalizePhotos_(value) {
  var seen = {};
  var result = [];

  parseArray_(value).slice(0, 20).forEach(function (item) {
    if (!item || typeof item !== 'object') return;
    var id = String(item.id == null ? '' : item.id).trim().slice(0, 100);
    if (!id || seen[id]) return;

    var mime = String(item.mime || 'image/jpeg').toLowerCase();
    if (mime.indexOf('image/') !== 0) mime = 'image/jpeg';
    seen[id] = true;

    result.push({
      id: id,
      mime: mime,
      width: numOrZero_(item.width),
      height: numOrZero_(item.height),
      size: numOrZero_(item.size),
      createdAt: numOrZero_(item.createdAt)
    });
  });

  return result;
}

function normalize_(raw) {
  if (!raw || typeof raw !== 'object') return null;

  var id = String(raw.id == null ? '' : raw.id).trim();
  if (!id) return null;

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  var createdAt = num(raw.createdAt) || Date.now();
  var due = String(raw.due == null ? '' : raw.due).trim();

  return {
    id: id.slice(0, 100),
    title: String(raw.title == null ? '' : raw.title).trim().slice(0, 500),
    notes: String(raw.notes == null ? '' : raw.notes).slice(0, 5000),
    done: raw.done === true || raw.done === 'TRUE' || raw.done === 'true' || raw.done === 1 || raw.done === '1',
    priority: raw.priority === 'high' ? 'high' : 'normal',
    due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : '',
    dueTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.dueTime || '')) ? String(raw.dueTime) : '',
    color: COLORS.indexOf(String(raw.color || '')) >= 0 ? String(raw.color) : '',
    icon: ICONS.indexOf(String(raw.icon || '')) >= 0 ? String(raw.icon) : '',
    subtasks: normalizeSubtasks_(raw.subtasks),
    photos: normalizePhotos_(raw.photos),
    createdAt: createdAt,
    updatedAt: num(raw.updatedAt) || createdAt,
    deletedAt: num(raw.deletedAt)
  };
}

/* --------------------------------------------------------------------------
 *  Фотографии
 *  Сами файлы лежат на листе «photos» кусками base64 (ячейка Sheets вмещает 50k).
 *  В задаче хранятся только метаданные: id, mime, размеры.
 * ------------------------------------------------------------------------ */

function getPhotosSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(CFG.PHOTO_SHEET);
  if (!sheet) sheet = ss.insertSheet(CFG.PHOTO_SHEET);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, PHOTO_COLUMNS.length).setValues([PHOTO_COLUMNS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }

  var header = sheet.getRange(1, 1, 1, PHOTO_COLUMNS.length).getValues()[0].map(function (cell) {
    return String(cell == null ? '' : cell).trim();
  });
  var matches = PHOTO_COLUMNS.every(function (column, index) { return header[index] === column; });

  if (!matches) {
    if (String(header[0] || '').toLowerCase() !== 'id') {
      throw new Error('На листе «' + CFG.PHOTO_SHEET + '» неожиданные заголовки. Переименуйте или удалите этот лист.');
    }
    sheet.getRange(1, 1, 1, PHOTO_COLUMNS.length).setValues([PHOTO_COLUMNS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function photoRows_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, PHOTO_COLUMNS.length).getValues();
}

function photoIdRows_(rows, id) {
  var result = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() === id) {
      result.push({ row: i + 2, values: rows[i] });
    }
  }
  return result;
}

function photoInfo_(id) {
  var photoId = String(id == null ? '' : id).trim().slice(0, 100);
  if (!photoId) return null;

  var sheet = getPhotosSheet_();
  var rows = photoIdRows_(photoRows_(sheet), photoId);
  if (!rows.length) return null;

  var first = rows[0].values;
  return {
    id: photoId,
    taskId: String(first[1] || ''),
    createdAt: Number(first[2]) || 0,
    mime: String(first[3] || 'image/jpeg'),
    width: Number(first[4]) || 0,
    height: Number(first[5]) || 0,
    size: Number(first[6]) || 0,
    chunks: rows.length
  };
}

function photoGet_(id) {
  var info = photoInfo_(id);
  if (!info) return null;

  var sheet = getPhotosSheet_();
  var rows = photoIdRows_(photoRows_(sheet), info.id);

  info.data = rows
    .map(function (item) {
      return { index: Number(item.values[7]) || 0, data: String(item.values[8] || '') };
    })
    .sort(function (a, b) { return a.index - b.index; })
    .map(function (chunk) { return chunk.data; })
    .join('');

  return info;
}

function photoSave_(photo) {
  if (!photo || typeof photo !== 'object') {
    return json_({ ok: false, error: 'bad_request', message: 'Нет данных фотографии.' });
  }

  var id = String(photo.id || '').trim().slice(0, 100);
  var taskId = String(photo.taskId || '').trim().slice(0, 100);
  var mime = String(photo.mime || 'image/jpeg').toLowerCase();
  var data = String(photo.data || '');

  if (!id || !taskId) {
    return json_({ ok: false, error: 'bad_request', message: 'Не указан id фотографии или задачи.' });
  }
  if (mime.indexOf('image/') !== 0) {
    return json_({ ok: false, error: 'bad_request', message: 'Можно загружать только изображения.' });
  }
  if (!data || data.length > CFG.PHOTO_MAX_CHARS) {
    return json_({ ok: false, error: 'bad_request', message: 'Пустое или слишком большое фото.' });
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return json_({ ok: false, error: 'busy', message: 'Таблица занята, повторите.' });
  }

  try {
    var sheet = getPhotosSheet_();
    deletePhotoIds_(sheet, [id]);

    var rows = [];
    var index = 0;
    for (var offset = 0; offset < data.length; offset += CFG.PHOTO_CHUNK) {
      rows.push([
        id,
        taskId,
        Number(photo.createdAt) || Date.now(),
        mime,
        Number(photo.width) || 0,
        Number(photo.height) || 0,
        Number(photo.size) || 0,
        index,
        data.slice(offset, offset + CFG.PHOTO_CHUNK)
      ]);
      index++;
    }

    var range = sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, PHOTO_COLUMNS.length);
    range.setNumberFormat('@');
    range.setValues(rows);

    return json_({ ok: true, id: id, chunks: rows.length });
  } finally {
    lock.releaseLock();
  }
}

function deletePhotoIds_(sheet, ids) {
  var wanted = {};
  (ids || []).forEach(function (id) {
    var value = String(id == null ? '' : id).trim();
    if (value) wanted[value] = true;
  });
  if (!Object.keys(wanted).length) return 0;

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  var rows = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var targets = [];
  for (var i = rows.length - 1; i >= 0; i--) {
    if (wanted[String(rows[i][0] || '').trim()]) targets.push(i + 2);
  }
  targets.forEach(function (rowNumber) { sheet.deleteRow(rowNumber); });
  return targets.length;
}

function photoDelete_(ids) {
  var list = Array.isArray(ids) ? ids.slice(0, 500) : [];
  if (!list.length) return json_({ ok: true, deleted: 0 });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return json_({ ok: false, error: 'busy', message: 'Таблица занята, повторите.' });
  }

  try {
    var deleted = deletePhotoIds_(getPhotosSheet_(), list);
    return json_({ ok: true, deleted: deleted });
  } finally {
    lock.releaseLock();
  }
}

/* --------------------------------------------------------------------------
 *  Обслуживание (запускается вручную из редактора Apps Script)
 * ------------------------------------------------------------------------ */

/**
 * Проверка логики и доступа к таблице.
 * Запустите вручную и посмотрите «Журнал выполнения».
 */
function selfTest() {
  var sample = [
    { id: 'a', title: 'Первая', updatedAt: 1000, createdAt: 1000 },
    { id: 'b', title: 'Вторая', updatedAt: 2000, createdAt: 2000 }
  ];
  var incoming = [{ id: 'b', title: 'Вторая (новое имя)', updatedAt: 3000, createdAt: 2000 }];
  var result = merge_(sample, incoming);
  Logger.log('Записей после мержа: %s, изменено: %s, заголовок b: %s',
    result.items.length, result.changed, result.items[1].title);
  Logger.log('Активных на листе: %s', countActive_(readAll_()));
  Logger.log('Строк на листе photos: %s', getPhotosSheet_().getLastRow());
  Logger.log('Токен задан: %s', CFG.TOKEN !== 'CHANGE_ME_на_длинный_секрет');
}

/**
 * Создаёт листы tasks и photos с заголовками, если их ещё нет.
 */
function setupSheet() {
  var tasks = getSheet_();
  var photos = getPhotosSheet_();
  Logger.log('Готово. Лист «%s», строк: %s; лист «%s», строк: %s',
    tasks.getName(), tasks.getLastRow(), photos.getName(), photos.getLastRow());
}

/**
 * Удаляет «надгробия» (удалённые записи) старше указанного количества дней.
 * Обычно не требуется. Запускать вручную.
 */
function cleanupTombstones(days) {
  var limitDays = Number(days) || 180;
  var threshold = Date.now() - limitDays * 24 * 60 * 60 * 1000;
  var all = readAll_();
  var kept = all.filter(function (r) { return !r.deletedAt || r.deletedAt > threshold; });
  writeAll_(kept);
  Logger.log('Было %s, осталось %s (порог %s дней).', all.length, kept.length, limitDays);
}

/**
 * Удаляет фотографии, на которые не ссылается ни одна задача
 * (например, если черновик закрыли, не сохранив).
 * По умолчанию не трогает фото моложе 7 дней.
 */
function cleanupOrphanPhotos(days) {
  var limitDays = Number(days) || 7;
  var threshold = Date.now() - limitDays * 24 * 60 * 60 * 1000;
  var referenced = {};

  readAll_().forEach(function (task) {
    (task.photos || []).forEach(function (photo) { referenced[photo.id] = true; });
  });

  var sheet = getPhotosSheet_();
  var rows = photoRows_(sheet);
  var orphans = {};

  rows.forEach(function (row) {
    var id = String(row[0] || '').trim();
    if (!id || referenced[id]) return;
    var createdAt = Number(row[2]) || 0;
    if (createdAt && createdAt > threshold) return;
    orphans[id] = true;
  });

  var deleted = deletePhotoIds_(sheet, Object.keys(orphans));
  Logger.log('Фото: удалено строк %s, самих фото %s (порог %s дней).',
    deleted, Object.keys(orphans).length, limitDays);
}
