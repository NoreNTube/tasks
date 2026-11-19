/**
 * Фотографии задач.
 * - сжатие в браузере (canvas → JPEG, максимум 1280 px);
 * - кэш данных в IndexedDB (localStorage для этого слишком мал);
 * - очередь «pending» для фото, которые ещё не ушли в Google Таблицу.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'tasksync.photos';
  var DB_VERSION = 1;
  var STORE = 'photos';
  var MAX_SIDE = 1280;
  var MAX_BASE64 = 180000;
  var MAX_FILE_BYTES = 25 * 1024 * 1024;

  var memory = new Map();
  var dbPromise = null;

  function uid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function openDb() {
    if (!('indexedDB' in global)) return Promise.resolve(null);
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve) {
      var request;
      try {
        request = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        resolve(null);
        return;
      }
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { resolve(null); };
      request.onblocked = function () { resolve(null); };
    });

    return dbPromise;
  }

  async function dbPut(record) {
    memory.set(record.id, record);
    var db = await openDb();
    if (!db) return record;

    await new Promise(function (resolve) {
      try {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
      } catch (err) {
        resolve();
      }
    });
    return record;
  }

  async function dbGet(id) {
    if (memory.has(id)) return memory.get(id);
    var db = await openDb();
    if (!db) return null;

    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(STORE, 'readonly');
        var request = tx.objectStore(STORE).get(id);
        request.onsuccess = function () {
          var record = request.result || null;
          if (record) memory.set(record.id, record);
          resolve(record);
        };
        request.onerror = function () { resolve(null); };
      } catch (err) {
        resolve(null);
      }
    });
  }

  async function dbAll() {
    var db = await openDb();
    if (!db) return Array.from(memory.values());

    return new Promise(function (resolve) {
      var result = [];
      try {
        var tx = db.transaction(STORE, 'readonly');
        var request = tx.objectStore(STORE).openCursor();
        request.onsuccess = function () {
          var cursor = request.result;
          if (!cursor) {
            resolve(result);
            return;
          }
          result.push(cursor.value);
          cursor.continue();
        };
        request.onerror = function () {
          resolve(Array.from(memory.values()));
        };
      } catch (err) {
        resolve(Array.from(memory.values()));
      }
    });
  }

  async function dbDelete(id) {
    memory.delete(id);
    var db = await openDb();
    if (!db) return;

    await new Promise(function (resolve) {
      try {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
      } catch (err) {
        resolve();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Сжатие                                                             */
  /* ------------------------------------------------------------------ */

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var image = new Image();
      image.onload = function () {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Не удалось прочитать изображение. Попробуйте JPEG или PNG.'));
      };
      image.src = url;
    });
  }

  function drawResized(image, maxSide, quality) {
    var sourceWidth = image.width || 1;
    var sourceHeight = image.height || 1;
    var scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    var width = Math.max(1, Math.round(sourceWidth * scale));
    var height = Math.max(1, Math.round(sourceHeight * scale));

    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    var context = canvas.getContext('2d');
    if (!context) throw new Error('Браузер не поддерживает обработку изображений');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    return { dataUrl: canvas.toDataURL('image/jpeg', quality), width: width, height: height };
  }

  async function compress(file) {
    var image = await loadImage(file);
    var maxSide = MAX_SIDE;
    var quality = 0.76;
    var result = drawResized(image, maxSide, quality);

    while (result.dataUrl.length > MAX_BASE64 && maxSide > 420) {
      maxSide = Math.round(maxSide * 0.8);
      quality = Math.max(0.5, quality - 0.07);
      result = drawResized(image, maxSide, quality);
    }

    var pieces = result.dataUrl.split(',');
    var base64 = pieces.length > 1 ? pieces[1] : '';
    if (!base64) throw new Error('Не удалось подготовить фото');

    return {
      dataUrl: result.dataUrl,
      base64: base64,
      mime: 'image/jpeg',
      width: result.width,
      height: result.height,
      size: Math.round(base64.length * 0.75)
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Публичный интерфейс                                                */
  /* ------------------------------------------------------------------ */

  async function addLocal(taskId, file) {
    if (!file) throw new Error('Файл не выбран');
    if (file.type && file.type.indexOf('image/') !== 0) throw new Error('Это не изображение');
    if (file.size > MAX_FILE_BYTES) throw new Error('Фото больше 25 МБ');

    var compressed = await compress(file);
    var record = {
      id: uid(),
      taskId: taskId,
      dataUrl: compressed.dataUrl,
      mime: compressed.mime,
      width: compressed.width,
      height: compressed.height,
      size: compressed.size,
      createdAt: Date.now(),
      pending: true
    };

    await dbPut(record);
    return record;
  }

  function metaOf(record) {
    return {
      id: record.id,
      mime: record.mime || 'image/jpeg',
      width: record.width || 0,
      height: record.height || 0,
      size: record.size || 0,
      createdAt: record.createdAt || 0
    };
  }

  function uploadPayload(record) {
    var pieces = String(record.dataUrl || '').split(',');
    return {
      id: record.id,
      taskId: record.taskId,
      mime: record.mime || 'image/jpeg',
      width: record.width || 0,
      height: record.height || 0,
      size: record.size || 0,
      createdAt: record.createdAt || 0,
      data: pieces.length > 1 ? pieces[1] : ''
    };
  }

  async function listPending(taskId) {
    var all = await dbAll();
    return all.filter(function (record) {
      if (!record || !record.pending) return false;
      return taskId ? record.taskId === taskId : true;
    });
  }

  async function markUploaded(id) {
    var record = await dbGet(id);
    if (!record) return null;
    record.pending = false;
    await dbPut(record);
    return record;
  }

  async function put(record) {
    return dbPut(record);
  }

  async function get(id) {
    return dbGet(id);
  }

  async function remove(id) {
    return dbDelete(id);
  }

  async function removeMany(ids) {
    for (var i = 0; i < ids.length; i++) {
      await dbDelete(ids[i]);
    }
  }

  global.AppPhotos = {
    addLocal: addLocal,
    metaOf: metaOf,
    uploadPayload: uploadPayload,
    listPending: listPending,
    markUploaded: markUploaded,
    put: put,
    get: get,
    remove: remove,
    removeMany: removeMany
  };
})(window);

