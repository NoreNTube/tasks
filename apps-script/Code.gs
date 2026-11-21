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
 *    GET  ?action=ping&token=...                    → { ok, count, serverTime }
 *    POST { action:"login", token, login, password } → { ok, token(сессия), user, users }
 *    GET  ?action=getTasks&token=...&session=...     → { ok, items:[свои], users }
 *    POST { action:"sync", token, session, items }   → { ok, items:[свои], changed }
 *    POST { action:"photoSave", token, session, photo }
 *    GET  ?action=photo&token=...&session=...&id=... → { ok, photo:{...,data} }
 *    GET  ?action=photoInfo&token=...&session=...&id=...→ { ok, exists, chunks }
 *    POST { action:"photoDelete", token, session, ids }
 *
 *  Лист Users (семейные профили):
 *    id | login | password | name | role | telegramChatId | telegramUsername
 *    Пароли/PIN хранятся открытым текстом — доступ к таблице и есть защита.
 *    Токен Telegram-бота лежит НЕ в коде, а в «Свойствах скрипта» под ключом
 *    TELEGRAM_BOT_TOKEN (Проект → Настройки → Свойства скрипта).
 *
 *  Лист tasks:
 *    id | title | notes | done | priority | due | createdAt | updatedAt | deletedAt |
 *    color | icon | subtasks(JSON) | photos(JSON) | dueTime | postponed | notDone |
 *    createdBy | assignedTo
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

  // Лист семейных профилей и время жизни сессии (в секундах).
  USERS_SHEET: 'Users',
  SESSION_TTL: 43200, // 12 часов

  // Если скрипт создан НЕ внутри таблицы (не через «Расширения»),
  // впишите сюда ID таблицы из её URL: /spreadsheets/d/<ID>/edit
  SPREADSHEET_ID: '',

  // Предохранитель от случайной перезаписи огромного листа.
  MAX_ITEMS: 5000,

  // Лист для фотографий и размер одного «куска» base64 в ячейке.
  PHOTO_SHEET: 'photos',
  PHOTO_CHUNK: 40000,
  PHOTO_MAX_CHARS: 400000,

  VERSION: 6
};

// Порядок колонок на листе. Менять не нужно.
var COLUMNS = ['id', 'title', 'notes', 'done', 'priority', 'due', 'createdAt', 'updatedAt', 'deletedAt', 'color', 'icon', 'subtasks', 'photos', 'dueTime', 'postponed', 'notDone', 'createdBy', 'assignedTo'];
var USER_COLUMNS = ['id', 'login', 'password', 'name', 'role', 'telegramChatId', 'telegramUsername'];
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

    // Telegram присылает апдейты (JSON с update_id/message) без нашего токена,
    // поэтому webhook обрабатываем до проверки CFG.TOKEN.
    if (isTelegramUpdate_(payload)) {
      return handleTelegramUpdate_(payload);
    }

    var token = String(payload.token || params.token || '');

    if (!CFG.TOKEN || CFG.TOKEN === 'CHANGE_ME_на_длинный_секрет') {
      return json_({ ok: false, error: 'server_not_configured', message: 'В Code.gs не задан TOKEN.' });
    }
    if (!token || token !== CFG.TOKEN) {
      return json_({ ok: false, error: 'unauthorized', message: 'Неверный токен доступа.' });
    }

    var action = String(payload.action || params.action || 'getTasks');
    var session = String(payload.session || params.session || '');

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

    if (action === 'login') {
      return login_(payload, params);
    }

    if (action === 'getTasks' || action === 'pull') {
      return getTasks_(session);
    }

    // Фотографии доступны только вошедшим пользователям.
    if (action === 'photoSave') {
      if (!resolveUserId_(session)) return authRequired_();
      return photoSave_(payload.photo);
    }

    if (action === 'photo' || action === 'photoGet') {
      if (!resolveUserId_(session)) return authRequired_();
      return json_({ ok: true, photo: photoGet_(payload.id || params.id) });
    }

    if (action === 'photoInfo') {
      if (!resolveUserId_(session)) return authRequired_();
      var photoInfo = photoInfo_(payload.id || params.id);
      return json_({
        ok: true,
        exists: Boolean(photoInfo),
        chunks: photoInfo ? photoInfo.chunks : 0,
        size: photoInfo ? photoInfo.size : 0
      });
    }

    if (action === 'photoDelete') {
      if (!resolveUserId_(session)) return authRequired_();
      return photoDelete_(payload.ids);
    }

    if (action === 'sync') {
      var userId = resolveUserId_(session);
      if (!userId) return authRequired_();

      var items = Array.isArray(payload.items) ? payload.items : [];
      if (items.length > CFG.MAX_ITEMS) {
        return json_({ ok: false, error: 'too_many', message: 'Слишком много записей за один запрос.' });
      }

      var lock = LockService.getScriptLock();
      if (!lock.tryLock(30000)) {
        return json_({ ok: false, error: 'busy', message: 'Таблица занята другой синхронизацией.' });
      }
      try {
        var serverTasks = readUserTasks_(userId);
        var validIds = validUserIds_();
        var prepared = items.map(function (raw) {
          return prepareIncoming_(raw, userId, serverTasks, validIds);
        }).filter(Boolean);
        var merged = merge_(serverTasks, prepared);
        // Пишем только строки текущего пользователя, не трогая чужие задачи.
        if (merged.changed > 0) upsertTasks_(merged.items);
        // Уведомления шлём после сохранения: ошибка Telegram не должна ломать задачу.
        if (merged.changed > 0) notifyTaskAssignments_(serverTasks, prepared);
        return json_({
          ok: true,
          items: merged.items,
          changed: merged.changed,
          users: publicUsers_(),
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

/* --------------------------------------------------------------------------
 *  Пользователи, вход и сессии
 * ------------------------------------------------------------------------ */

function authRequired_() {
  return json_({ ok: false, error: 'auth_required', message: 'Сессия истекла. Войдите заново.' });
}

/**
 * Вход по логину и PIN/паролю из листа Users.
 * Возвращает сессионный токен, данные пользователя и список пользователей
 * (только id и name — без паролей) для выпадающего списка назначения.
 */
function login_(payload, params) {
  var login = String(payload.login || (params && params.login) || '').trim();
  var password = String(payload.password || (params && params.password) || '');

  if (!login || !password) {
    return json_({ ok: false, error: 'bad_login', message: 'Введите логин и PIN/пароль.' });
  }

  var user = findUserByLogin_(login);
  var stored = user ? String(user.password) : '';
  if (!user || (stored !== password && stored.trim() !== password.trim())) {
    return json_({ ok: false, error: 'bad_login', message: 'Неверный логин или PIN/пароль.' });
  }

  // Первый успешный вход дополняет старые задачи владельцем (обычно админ),
  // чтобы они не пропали после включения фильтра по пользователю.
  try {
    ensureOwnershipBackfill_();
  } catch (err) {
    Logger.log('Не удалось перенести старые задачи: %s', err);
  }

  var session = createSession_(user.id);
  return json_({
    ok: true,
    action: 'login',
    token: session,
    user: publicUser_(user),
    users: publicUsers_(),
    serverTime: Date.now(),
    version: CFG.VERSION
  });
}

/** Задачи, видимые пользователю: назначенные ему или созданные им. */
function getTasks_(session) {
  var userId = resolveUserId_(session);
  if (!userId) return authRequired_();
  return json_({
    ok: true,
    action: 'getTasks',
    items: readUserTasks_(userId),
    users: publicUsers_(),
    serverTime: Date.now(),
    version: CFG.VERSION
  });
}

function createSession_(userId) {
  var key = Utilities.getUuid();
  CacheService.getScriptCache().put('session:' + key, String(userId), CFG.SESSION_TTL);
  return key;
}

function resolveUserId_(session) {
  var key = String(session || '').trim();
  if (!key) return '';
  try {
    var userId = CacheService.getScriptCache().get('session:' + key);
    return userId ? String(userId) : '';
  } catch (err) {
    return '';
  }
}

function tasksForUser_(items, userId) {
  var id = String(userId == null ? '' : userId).trim();
  if (!id) return [];
  return (items || []).filter(function (task) {
    if (!task) return false;
    return String(task.assignedTo || '').trim() === id ||
      String(task.createdBy || '').trim() === id;
  });
}

function readUserTasks_(userId) {
  return tasksForUser_(readAll_(), userId);
}

/**
 * Готовит входящую задачу к записи: createdBy при создании ставит сервер,
 * assignedTo проверяется по списку пользователей. createdBy существующей
 * задачи не перезаписывается.
 */
function prepareIncoming_(raw, userId, serverTasks, validIds) {
  var rec = normalize_(raw);
  if (!rec) return null;

  var existing = null;
  for (var i = 0; i < serverTasks.length; i++) {
    if (serverTasks[i].id === rec.id) {
      existing = serverTasks[i];
      break;
    }
  }

  var allowed = validIds || {};
  if (existing) {
    rec.createdBy = existing.createdBy || userId;
    if (!rec.assignedTo || !allowed[rec.assignedTo]) {
      rec.assignedTo = existing.assignedTo || userId;
    }
  } else {
    rec.createdBy = userId;
    if (!rec.assignedTo || !allowed[rec.assignedTo]) {
      rec.assignedTo = userId;
    }
  }
  return rec;
}

/**
 * Построчно обновляет или добавляет задачи, не стирая чужие строки.
 * Возвращает количество записанных записей.
 */
function upsertTasks_(records) {
  var list = (records || []).filter(function (rec) { return rec && rec.id; });
  if (!list.length) return 0;

  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  var rows = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).getValues() : [];

  var rowById = {};
  for (var i = 0; i < rows.length; i++) {
    var id = String(rows[i][0] == null ? '' : rows[i][0]).trim();
    if (id) rowById[id] = i + 2;
  }

  // Все значения храним как текст: даты и «TRUE» не превращаются в типы Sheets.
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).setNumberFormat('@');
  }

  var toAppend = [];
  var written = 0;

  list.forEach(function (rec) {
    var values = recordToRow_(rec);
    var rowNumber = rowById[rec.id];
    if (rowNumber > 0) {
      sheet.getRange(rowNumber, 1, 1, COLUMNS.length).setValues([values]);
      written++;
    } else if (rowNumber === undefined) {
      toAppend.push(values);
      rowById[rec.id] = -1; // защита от дублей в одном пакете
      written++;
    }
  });

  if (toAppend.length) {
    var startRow = Math.max(sheet.getLastRow() + 1, 2);
    var appendRange = sheet.getRange(startRow, 1, toAppend.length, COLUMNS.length);
    appendRange.setNumberFormat('@');
    appendRange.setValues(toAppend);
  }
  return written;
}

/* --------------------------------------------------------------------------
 *  Лист Users
 * ------------------------------------------------------------------------ */

function getUsersSheet_() {
  var ss = getSpreadsheet_();
  var sheet = null;
  var wanted = CFG.USERS_SHEET.trim().toLowerCase();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().trim().toLowerCase() === wanted) {
      sheet = sheets[i];
      break;
    }
  }
  if (!sheet) sheet = ss.insertSheet(CFG.USERS_SHEET);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, USER_COLUMNS.length).setValues([USER_COLUMNS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }

  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  var first = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (cell) {
    return String(cell == null ? '' : cell).trim();
  });
  while (first.length && first[first.length - 1] === '') first.pop();

  var matches = first.length === USER_COLUMNS.length && USER_COLUMNS.every(function (column, index) {
    return first[index] === column;
  });
  if (matches) return sheet;

  var isPrefix = first.length < USER_COLUMNS.length && first.every(function (column, index) {
    return column === USER_COLUMNS[index];
  });
  if (isPrefix) {
    sheet.getRange(1, 1, 1, USER_COLUMNS.length).setValues([USER_COLUMNS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  }

  throw new Error(
    'На листе «' + CFG.USERS_SHEET + '» ожидаются заголовки: ' + USER_COLUMNS.join(', ') + '.'
  );
}

function readUsers_() {
  var sheet = getUsersSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, USER_COLUMNS.length).getDisplayValues();
  var users = [];

  values.forEach(function (row) {
    var id = String(row[0] == null ? '' : row[0]).trim();
    var login = String(row[1] == null ? '' : row[1]).trim();
    if (!id && !login) return;
    if (!id) id = login;
    var name = String(row[3] == null ? '' : row[3]).trim();
    users.push({
      id: id.slice(0, 100),
      login: login.slice(0, 100),
      password: String(row[2] == null ? '' : row[2]),
      name: (name || login || id).slice(0, 100),
      role: String(row[4] == null ? '' : row[4]).trim().toLowerCase() === 'admin' ? 'admin' : 'member',
      telegramChatId: String(row[5] == null ? '' : row[5]).trim().slice(0, 100),
      telegramUsername: String(row[6] == null ? '' : row[6]).trim().replace(/^@/, '').slice(0, 100)
    });
  });

  return users;
}

function publicUser_(user) {
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    role: user.role,
    telegramChatId: user.telegramChatId || '',
    telegramUsername: user.telegramUsername || ''
  };
}

/** Список для выпадающего списка и шапки: без паролей, но со статусом Telegram. */
function publicUsers_() {
  return readUsers_().map(function (user) {
    return {
      id: user.id,
      name: user.name,
      telegramChatId: user.telegramChatId || '',
      telegramUsername: user.telegramUsername || ''
    };
  });
}

function validUserIds_() {
  var map = {};
  readUsers_().forEach(function (user) { map[user.id] = true; });
  return map;
}

function findUserByLogin_(login) {
  var key = String(login == null ? '' : login).trim().toLowerCase();
  if (!key) return null;
  var users = readUsers_();
  for (var i = 0; i < users.length; i++) {
    if (users[i].login.toLowerCase() === key) return users[i];
  }
  // Если в колонке login пусто (или ввели id), разрешаем вход по идентификатору.
  for (var j = 0; j < users.length; j++) {
    if (String(users[j].id).toLowerCase() === key) return users[j];
  }
  return null;
}

function findUserById_(id) {
  var key = String(id == null ? '' : id).trim().toLowerCase();
  if (!key) return null;
  var users = readUsers_();
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].id).toLowerCase() === key) return users[i];
  }
  return null;
}

function firstOwnerId_() {
  var users = readUsers_();
  if (!users.length) return '';
  for (var i = 0; i < users.length; i++) {
    if (users[i].role === 'admin') return users[i].id;
  }
  return users[0].id;
}

/**
 * Разово назначает старые задачи (без createdBy/assignedTo) первому админу.
 * Возвращает число обновлённых задач.
 */
function ensureOwnershipBackfill_() {
  var legacy = readAll_().filter(function (task) {
    return !task.createdBy && !task.assignedTo;
  });
  if (!legacy.length) return 0;

  var owner = firstOwnerId_();
  if (!owner) return 0;

  legacy.forEach(function (task) {
    task.createdBy = owner;
    task.assignedTo = owner;
  });
  upsertTasks_(legacy);
  return legacy.length;
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

  // Лист, созданный старой версией (меньше колонок): его заголовки —
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
    rec.dueTime || '',
    rec.postponed ? 'TRUE' : '',
    rec.notDone ? 'TRUE' : '',
    rec.createdBy || '',
    rec.assignedTo || ''
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
    rec.id, rec.title, rec.notes, rec.done, rec.notDone, rec.postponed,
    rec.priority, rec.due, rec.dueTime, rec.createdAt, rec.updatedAt, rec.deletedAt,
    rec.color, rec.icon, rec.subtasks, rec.photos, rec.createdBy, rec.assignedTo
  ]);
}

function numOrZero_(value) {
  var n = Number(value);
  return isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function bool_(value) {
  return value === true || value === 'TRUE' || value === 'true' || value === 1 || value === '1';
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
  var done = bool_(raw.done);

  return {
    id: id.slice(0, 100),
    title: String(raw.title == null ? '' : raw.title).trim().slice(0, 500),
    notes: String(raw.notes == null ? '' : raw.notes).slice(0, 5000),
    done: done,
    notDone: bool_(raw.notDone) && !done,
    postponed: bool_(raw.postponed),
    priority: raw.priority === 'high' ? 'high' : 'normal',
    due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : '',
    dueTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.dueTime || '')) ? String(raw.dueTime) : '',
    color: COLORS.indexOf(String(raw.color || '')) >= 0 ? String(raw.color) : '',
    icon: ICONS.indexOf(String(raw.icon || '')) >= 0 ? String(raw.icon) : '',
    subtasks: normalizeSubtasks_(raw.subtasks),
    photos: normalizePhotos_(raw.photos),
    createdBy: String(raw.createdBy == null ? '' : raw.createdBy).trim().slice(0, 100),
    assignedTo: String(raw.assignedTo == null ? '' : raw.assignedTo).trim().slice(0, 100),
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
 *  Telegram: уведомления о задачах и привязка чата
 *  Токен бота НЕ хранится в коде: он лежит в «Свойствах скрипта»
 *  (Проект → Настройки → Свойства скрипта) под ключом TELEGRAM_BOT_TOKEN.
 * ------------------------------------------------------------------------ */

var TELEGRAM_API = 'https://api.telegram.org/bot';

function getTelegramToken_() {
  try {
    var token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
    return String(token || '').trim();
  } catch (err) {
    Logger.log('Не удалось прочитать TELEGRAM_BOT_TOKEN: %s', err);
    return '';
  }
}

/** Тело запроса — апдейт от Telegram, а не вызов нашего JSON API. */
function isTelegramUpdate_(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return payload.update_id != null || (payload.message && typeof payload.message === 'object');
}

/** Экранирует текст для parse_mode:"HTML". */
function telegramEscape_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Текст уведомления о новой/переназначенной задаче (чистая функция для тестов). */
function telegramTaskMessage_(task, senderName, kind) {
  var rec = task || {};
  var sender = String(senderName == null ? '' : senderName).trim() || 'члена семьи';
  var due = String(rec.due == null ? '' : rec.due).trim();
  var dueTime = String(rec.dueTime == null ? '' : rec.dueTime).trim();
  var dueText = due ? (dueTime ? due + ' ' + dueTime : due) : 'Без срока';
  var title = String(rec.title == null ? '' : rec.title).trim() || 'Без названия';
  var headline = kind === 'reassigned'
    ? '🔁 <b>Задача переназначена на вас — от ' + telegramEscape_(sender) + '</b>'
    : '📌 <b>Новая задача от ' + telegramEscape_(sender) + '</b>';

  return [
    headline,
    '📝 <b>Задача:</b> ' + telegramEscape_(title),
    '⏰ <b>Срок:</b> ' + telegramEscape_(dueText)
  ].join('\n');
}

function sendTelegramMessage_(chatId, text) {
  var id = String(chatId == null ? '' : chatId).trim();
  if (!id || !text) return false;

  var token = getTelegramToken_();
  if (!token) {
    Logger.log('Telegram: TELEGRAM_BOT_TOKEN не задан — сообщение не отправлено.');
    return false;
  }

  try {
    var response = UrlFetchApp.fetch(TELEGRAM_API + token + '/sendMessage', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: id,
        text: String(text),
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    if (code !== 200) Logger.log('Telegram sendMessage (%s): %s', code, response.getContentText());
    return code === 200;
  } catch (err) {
    // Ошибка Telegram не должна ломать сохранение задачи.
    Logger.log('Telegram sendMessage ошибка: %s', err);
    return false;
  }
}

/** Шлёт уведомление получателю задачи, если он привязал Telegram и это не он сам. */
function sendTelegramTaskNotification_(task, kind) {
  if (!task) return false;
  var assignedTo = String(task.assignedTo == null ? '' : task.assignedTo).trim();
  var createdBy = String(task.createdBy == null ? '' : task.createdBy).trim();
  if (!assignedTo) return false;
  if (assignedTo === createdBy) return false; // самому себе не шлём

  var receiver = findUserById_(assignedTo);
  if (!receiver || !receiver.telegramChatId) return false;

  var sender = findUserById_(createdBy);
  var senderName = sender ? sender.name : createdBy;
  return sendTelegramMessage_(receiver.telegramChatId, telegramTaskMessage_(task, senderName, kind));
}

/**
 * Сравнивает серверные задачи с пришедшими и шлёт уведомления о новых
 * задачах и о смене исполнителя. Устаревшие записи (проигравшие merge) пропускает.
 */
function notifyTaskAssignments_(serverTasks, incoming) {
  var base = Array.isArray(serverTasks) ? serverTasks : [];
  var list = Array.isArray(incoming) ? incoming : [];

  list.forEach(function (rec) {
    if (!rec || !rec.id) return;

    var existing = null;
    for (var i = 0; i < base.length; i++) {
      if (base[i].id === rec.id) { existing = base[i]; break; }
    }
    if (existing && !wins_(rec, existing)) return;

    var isNew = !existing;
    var reassigned = Boolean(existing) &&
      String(existing.assignedTo || '').trim() !== String(rec.assignedTo || '').trim();
    if (!isNew && !reassigned) return;

    sendTelegramTaskNotification_(rec, isNew ? 'new' : 'reassigned');
  });
}

/** Пишет telegramChatId/username в лист Users для указанного пользователя. */
function bindTelegramChat_(user, chatId, username) {
  var id = String(chatId == null ? '' : chatId).trim().slice(0, 100);
  if (!user || !id) return false;

  var sheet = getUsersSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  var chatColumn = USER_COLUMNS.indexOf('telegramChatId') + 1;
  var nameColumn = USER_COLUMNS.indexOf('telegramUsername') + 1;
  var rows = sheet.getRange(2, 1, lastRow - 1, USER_COLUMNS.length).getDisplayValues();
  var wantedLogin = String(user.login || '').toLowerCase();

  for (var i = 0; i < rows.length; i++) {
    var rowId = String(rows[i][0] == null ? '' : rows[i][0]).trim();
    var rowLogin = String(rows[i][1] == null ? '' : rows[i][1]).trim().toLowerCase();
    if (rowId !== user.id && rowLogin !== wantedLogin) continue;

    var row = i + 2;
    sheet.getRange(row, chatColumn).setNumberFormat('@').setValue(id);
    if (nameColumn > 0) {
      var uname = String(username == null ? '' : username).trim().replace(/^@/, '').slice(0, 100);
      sheet.getRange(row, nameColumn).setNumberFormat('@').setValue(uname);
    }
    return true;
  }
  return false;
}

/** Обрабатывает входящий апдейт Telegram (webhook /start <login>). */
function handleTelegramUpdate_(update) {
  try {
    var message = (update && update.message) || null;
    if (!message) return json_({ ok: true });

    var chat = message.chat || {};
    var chatId = chat.id;
    if (chatId == null) return json_({ ok: true });

    var text = String(message.text == null ? '' : message.text).trim();
    var startMatch = /^\/start(?:@\w+)?(?:\s+([\s\S]+))?$/i.exec(text);
    if (!startMatch) {
      sendTelegramMessage_(chatId, 'Напишите /start &lt;login&gt;, например /start gleb, чтобы подключить уведомления.');
      return json_({ ok: true });
    }

    var login = String(startMatch[1] || '').trim().split(/\s+/)[0];
    if (!login) {
      sendTelegramMessage_(chatId, 'Укажите логин: /start &lt;login&gt;, например /start gleb.');
      return json_({ ok: true });
    }

    var user = findUserByLogin_(login);
    if (!user) {
      sendTelegramMessage_(chatId,
        'Не удалось найти пользователя с логином «' + telegramEscape_(login) + '». ' +
        'Проверьте колонку login на листе Users.');
      return json_({ ok: true });
    }

    bindTelegramChat_(user, chatId, chat.username || '');
    sendTelegramMessage_(chatId,
      '✅ Привет, ' + telegramEscape_(user.name) + '! Уведомления о новых задачах подключены');
    return json_({ ok: true });
  } catch (err) {
    Logger.log('handleTelegramUpdate_ ошибка: %s', err);
    return json_({ ok: true });
  }
}

/**
 * Привязывает URL веб-приложения к Telegram (Webhook).
 * Запустите вручную из редактора Apps Script один раз после развёртывания.
 */
function setTelegramWebhook() {
  var token = getTelegramToken_();
  if (!token) {
    Logger.log('Сначала добавьте TELEGRAM_BOT_TOKEN в «Свойства скрипта».');
    return;
  }
  var url = ScriptApp.getService().getUrl();
  if (!url) {
    Logger.log('Не удалось получить URL веб-приложения. Разверните его как «Веб-приложение».');
    return;
  }
  var response = UrlFetchApp.fetch(TELEGRAM_API + token + '/setWebhook', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ url: url, allowed_updates: ['message'] }),
    muteHttpExceptions: true
  });
  Logger.log('setWebhook → %s: %s', response.getResponseCode(), response.getContentText());
}

/** Удаляет webhook (для отладки). Запускается вручную. */
function deleteTelegramWebhook() {
  var token = getTelegramToken_();
  if (!token) {
    Logger.log('Сначала добавьте TELEGRAM_BOT_TOKEN в «Свойства скрипта».');
    return;
  }
  var response = UrlFetchApp.fetch(TELEGRAM_API + token + '/deleteWebhook', {
    method: 'post',
    muteHttpExceptions: true
  });
  Logger.log('deleteWebhook → %s: %s', response.getResponseCode(), response.getContentText());
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
  Logger.log('Пользователей на листе Users: %s', readUsers_().length);
  Logger.log('Токен задан: %s', CFG.TOKEN !== 'CHANGE_ME_на_длинный_секрет');
  Logger.log('Telegram-бот настроен: %s', Boolean(getTelegramToken_()));
}

/**
 * Диагностика листа Users. Запустите вручную из редактора Apps Script
 * и посмотрите «Журнал выполнения». Пароли маскируются.
 */
function debugUsers() {
  var ss = getSpreadsheet_();
  var wanted = CFG.USERS_SHEET.trim().toLowerCase();
  var sheet = null;
  ss.getSheets().forEach(function (s) {
    if (!sheet && s.getName().trim().toLowerCase() === wanted) sheet = s;
  });

  if (!sheet) {
    Logger.log('Лист «%s» НЕ НАЙДЕН. Запустите setupSheet().', CFG.USERS_SHEET);
    Logger.log('Есть листы: %s', ss.getSheets().map(function (s) { return s.getName(); }).join(', '));
    return;
  }

  Logger.log('Лист найден: «%s», строк: %s, колонок: %s',
    sheet.getName(), sheet.getLastRow(), sheet.getLastColumn());

  var rows = sheet.getLastRow() >= 1
    ? sheet.getRange(1, 1, Math.min(sheet.getLastRow(), 15),
      Math.max(sheet.getLastColumn(), USER_COLUMNS.length)).getDisplayValues()
    : [];

  rows.forEach(function (row, index) {
    var safe = row.map(function (cell, col) {
      return col === 2 ? '***(' + String(cell).length + ')' : cell;
    });
    Logger.log('Строка %s: %s', index + 1, JSON.stringify(safe));
  });

  try {
    var users = readUsers_();
    Logger.log('readUsers_ прочитал пользователей: %s', users.length);
    users.forEach(function (user, i) {
      Logger.log('  #%s id=%s login=%s name=%s role=%s passwordLength=%s telegramChatId=%s',
        i + 1, user.id, user.login, user.name, user.role, String(user.password).length,
        user.telegramChatId || '(не привязан)');
    });
  } catch (err) {
    Logger.log('readUsers_ ошибка: %s', err);
  }
}

/**
 * Проверка конкретного логина/пароля без раскрытия сохранённого пароля.
 * В редакторе: выберите debugLogin и задайте аргументы либо вызовите
 * из другой функции: debugLogin('mama', '1234').
 */
function debugLogin(login, password) {
  try {
    var user = findUserByLogin_(String(login || ''));
    if (!user) {
      Logger.log('Пользователь «%s» не найден ни по login, ни по id.', login);
      var users = readUsers_();
      Logger.log('Известные логины: %s', users.map(function (u) {
        return u.login || ('id:' + u.id);
      }).join(', '));
      return;
    }

    var stored = String(user.password);
    var given = String(password || '');
    Logger.log('Найден: id=%s, login=%s, name=%s, role=%s', user.id, user.login, user.name, user.role);
    Logger.log('Пароль совпадает точно: %s; после обрезки пробелов: %s',
      stored === given, stored.trim() === given.trim());
    Logger.log('Длина введённого: %s; длина в таблице: %s', given.length, stored.length);
  } catch (err) {
    Logger.log('debugLogin ошибка: %s', err);
  }
}

/**
 * Создаёт листы tasks, Users и photos с заголовками, если их ещё нет,
 * и назначает старые задачи первому администратору.
 */
function setupSheet() {
  var tasks = getSheet_();
  var users = getUsersSheet_();
  var photos = getPhotosSheet_();
  var migrated = ensureOwnershipBackfill_();
  Logger.log('Готово. Лист «%s», строк: %s; лист «%s», строк: %s; лист «%s», строк: %s; перенесено задач: %s',
    tasks.getName(), tasks.getLastRow(), users.getName(), users.getLastRow(),
    photos.getName(), photos.getLastRow(), migrated);
  if (users.getLastRow() < 2) {
    Logger.log('Добавьте пользователей на лист Users: id | login | password | name | role');
  }
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
