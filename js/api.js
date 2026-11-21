/**
 * Клиент JSON API Google Apps Script.
 *
 * Запросы на чтение — GET (CORS-простой запрос).
 * Запись — POST с Content-Type: text/plain, чтобы браузер не делал preflight.
 * Если ответ POST не читается из-за CORS, отправляем его в режиме no-cors
 * и затем проверяем результат обычным GET (pull).
 */
(function (global) {
  'use strict';

  var TIMEOUT_MS = 25000;
  var URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:[?#][^\s]*)?$/i;

  var MESSAGES = {
    not_configured: 'Не указан адрес веб-приложения Apps Script.',
    bad_url: 'Адрес должен иметь вид https://script.google.com/macros/s/…/exec',
    unauthorized: 'Неверный токен. Проверьте TOKEN в Code.gs и в настройках приложения.',
    server_not_configured: 'В Code.gs не задан TOKEN — откройте таблицу и поправьте скрипт.',
    busy: 'Таблица занята другой синхронизацией. Попробуйте ещё раз.',
    too_many: 'Слишком много записей за один запрос.',
    bad_login: 'Неверный логин или PIN/пароль.',
    auth_required: 'Сессия истекла. Войдите заново.',
    bad_response: 'Google вернул не JSON. Проверьте, что веб-приложение развёрнуто с доступом «Все» (Anyone) и URL заканчивается на /exec.',
    network: 'Нет связи с Google. Проверьте интернет.',
    timeout: 'Превышено время ожидания ответа Google.'
  };

  function ApiError(code, message) {
    var err = new Error(message || MESSAGES[code] || code);
    err.name = 'ApiError';
    err.code = code;
    return err;
  }

  function endpoint(settings) {
    var url = String((settings && settings.apiUrl) || '').trim();
    if (!url) throw ApiError('not_configured');
    if (!URL_PATTERN.test(url)) {
      // Разрешаем и URL вида .../dev (для отладки), но предупреждаем.
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/(exec|dev)/i.test(url)) {
        throw ApiError('bad_url');
      }
    }
    return url;
  }

  async function fetchWithTimeout(url, options) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    var opts = Object.assign({ cache: 'no-store', redirect: 'follow' }, options || {});
    if (controller) {
      opts.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    }
    try {
      return await fetch(url, opts);
    } catch (err) {
      if (err && err.name === 'AbortError') throw ApiError('timeout');
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function parseResponse(res) {
    var text = '';
    try {
      text = await res.text();
    } catch (err) {
      throw ApiError('network', MESSAGES.network);
    }

    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (err) {
      data = null;
    }

    if (!data || typeof data !== 'object') {
      if (res.status === 401 || res.status === 403) {
        throw ApiError('bad_response', 'Google требует вход. Откройте развёртывание Apps Script и поставьте доступ «Все» (Anyone).');
      }
      throw ApiError('bad_response');
    }

    if (data.ok === false) {
      throw ApiError(data.error || 'server', MESSAGES[data.error] || data.message || 'Ошибка на стороне Apps Script.');
    }

    return data;
  }

  function buildUrl(baseUrl, params) {
    var url = new URL(baseUrl);
    Object.keys(params).forEach(function (key) {
      if (params[key] !== undefined && params[key] !== null) {
        url.searchParams.set(key, String(params[key]));
      }
    });
    // Защита от кэша браузера.
    url.searchParams.set('_', String(Date.now()));
    return url.toString();
  }

  async function get(baseUrl, params) {
    var res = await fetchWithTimeout(buildUrl(baseUrl, params), { method: 'GET' });
    return parseResponse(res);
  }

  async function post(baseUrl, body) {
    var url = buildUrl(baseUrl, {});
    var payload = JSON.stringify(body);

    try {
      var res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: payload
      });
      return await parseResponse(res);
    } catch (err) {
      if (err && err.name === 'ApiError' && err.code !== 'network' && err.code !== 'bad_response') {
        throw err;
      }
      // Ответ мог не пройти CORS-проверку, хотя скрипт уже всё записал.
      // Отправляем "слепой" POST и подтвердим результат отдельным GET.
      try {
        await fetchWithTimeout(url, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: payload
        });
        return { ok: true, opaque: true };
      } catch (err2) {
        throw ApiError('network', MESSAGES.network);
      }
    }
  }

  async function ping(settings) {
    var base = endpoint(settings);
    var data = await get(base, { action: 'ping', token: settings.token });
    return {
      count: Number(data.count) || 0,
      total: Number(data.total) || 0,
      serverTime: Number(data.serverTime) || Date.now()
    };
  }

  async function login(settings, loginName, password) {
    var base = endpoint(settings);
    var data = await post(base, {
      action: 'login',
      token: settings.token,
      login: loginName,
      password: password
    });
    if (data && data.opaque) {
      throw ApiError('bad_response', 'Google не вернул данные входа. Проверьте доступ «Все» (Anyone) и HTTPS.');
    }
    if (!data.token || !data.user) {
      throw ApiError('bad_response', 'Вход не удался: сервер вернул неполные данные.');
    }
    return {
      token: String(data.token),
      user: data.user,
      users: Array.isArray(data.users) ? data.users : []
    };
  }

  async function pull(settings, session) {
    var base = endpoint(settings);
    var data = await get(base, { action: 'getTasks', token: settings.token, session: session });
    return {
      items: Array.isArray(data.items) ? data.items : [],
      users: Array.isArray(data.users) ? data.users : []
    };
  }

  async function push(settings, session, items) {
    var base = endpoint(settings);
    return post(base, { action: 'sync', token: settings.token, session: session, items: items });
  }

  async function photoSave(settings, session, photo) {
    var base = endpoint(settings);
    var data = await post(base, { action: 'photoSave', token: settings.token, session: session, photo: photo });

    if (data && data.ok === false) {
      throw ApiError('photo_save_failed', data.message || 'Не удалось сохранить фото.');
    }

    if (data && data.opaque) {
      // Ответ POST не прочитался — убеждаемся отдельным запросом, что фото в таблице.
      await new Promise(function (resolve) { setTimeout(resolve, 400); });
      var info = await photoInfo(settings, session, photo.id);
      if (!info.exists) {
        throw ApiError('photo_save_failed', 'Фото не сохранилось в Google Таблице. Проверьте доступ «Все» и токен.');
      }
      return { ok: true, id: photo.id, chunks: info.chunks };
    }

    return data;
  }

  async function photoInfo(settings, session, id) {
    var base = endpoint(settings);
    var data = await get(base, { action: 'photoInfo', token: settings.token, session: session, id: id });
    return { exists: Boolean(data.exists), chunks: Number(data.chunks) || 0 };
  }

  async function photoGet(settings, session, id) {
    var base = endpoint(settings);
    var data = await get(base, { action: 'photo', token: settings.token, session: session, id: id });
    if (!data.photo || !data.photo.data) {
      throw ApiError('photo_missing', 'Фото не найдено в Google Таблице.');
    }
    return data.photo;
  }

  async function photoDelete(settings, session, ids) {
    var base = endpoint(settings);
    return post(base, { action: 'photoDelete', token: settings.token, session: session, ids: ids });
  }

  global.AppApi = {
    ApiError: ApiError,
    ping: ping,
    login: login,
    pull: pull,
    push: push,
    photoSave: photoSave,
    photoInfo: photoInfo,
    photoGet: photoGet,
    photoDelete: photoDelete
  };
})(window);
