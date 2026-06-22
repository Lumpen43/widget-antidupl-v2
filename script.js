define(["jquery"], function ($) {
  var CustomWidget = function () {
    try {
      console.log("[Антидубль v2] Загрузка...");
      var self = this,
        system = self.system(),
        langs = self.langs;
      console.log("[Антидубль v2] system.area:", system ? system.area : "undefined");

      // =============================================================
      // API Core — $.ajax с токеном из настроек
      // =============================================================

      function getToken() {
        var s = self.get_settings();
        return s.api_token || "";
      }

      function apiAjax(method, url, data) {
        var token = getToken();
        var opts = {
          url: url,
          type: method,
          headers: { "Authorization": "Bearer " + token }
        };
        if (method === "POST" || method === "PATCH") {
          opts.contentType = "application/json";
          opts.data = JSON.stringify(data);
        }
        if (method === "GET" && data) opts.data = data;
        return $.ajax(opts);
      }

      function apiCall(method, url, data) {
        return new Promise(function (resolve, reject) {
          apiAjax(method, url, data)
            .done(resolve)
            .fail(function (jqXHR, textStatus, errorThrown) {
              reject({ status: jqXHR.status, message: errorThrown || textStatus, response: jqXHR.responseText });
            });
        });
      }

      function apiCallWithRetry(method, url, data, maxRetries) {
        maxRetries = maxRetries || 3;
        function attempt(n) {
          return apiCall(method, url, data).catch(function (err) {
            var status = err.status || 0;
            if (n < maxRetries - 1 && (status === 429 || status >= 500 || status === 0)) {
              var delay = 1000 * (n + 1);
              return new Promise(function (res) { setTimeout(res, delay); }).then(function () {
                return attempt(n + 1);
              });
            }
            throw err;
          });
        }
        return attempt(0);
      }

      // =============================================================
      // Пагинация через _links.next (API v4)
      // =============================================================

      function fetchAll(endpoint) {
        var all = [];
        function load(url) {
          return apiCallWithRetry("GET", url).then(function (resp) {
            if (resp._embedded) {
              var entities = resp._embedded[Object.keys(resp._embedded)[0]];
              if (entities) all = all.concat(entities);
            }
            if (resp._links && resp._links.next) {
              return load(resp._links.next.href);
            }
            return all;
          });
        }
        return load("/api/v4/" + endpoint + "?limit=250");
      }

      // =============================================================
      // Нормализация телефона
      // =============================================================

      function normalizePhone(raw) {
        if (!raw) return "";
        return raw.replace(/[^\d+]/g, "").replace(/^8/, "7").replace(/^\+?7/, "7").replace(/^7/, "7");
      }

      // =============================================================
      // Поиск дубликатов (один проход, хэш-карты)
      // =============================================================

      function getCustomFieldValues(contact, fieldCode) {
        if (!contact.custom_fields_values) return [];
        var f = contact.custom_fields_values.find(function (cf) {
          return cf.field_code === fieldCode;
        });
        if (!f || !f.values) return [];
        return f.values.map(function (v) { return (v.value || "").trim(); }).filter(Boolean);
      }

      function getGroupKey(values) {
        if (!values || values.length === 0) return null;
        return values.slice().sort().join("||");
      }

      function findDuplicateGroups(contacts, opts) {
        var phoneMap = {},
          emailMap = {},
          customMap = {},
          byId = {};

        contacts.forEach(function (c) {
          byId[c.id] = c;

          if (opts.comparePhone) {
            var phones = getCustomFieldValues(c, "PHONE").map(normalizePhone).filter(Boolean);
            var pk = getGroupKey(phones);
            if (pk) {
              if (!phoneMap[pk]) phoneMap[pk] = [];
              phoneMap[pk].push(c.id);
            }
          }

          if (opts.compareEmail) {
            var emails = getCustomFieldValues(c, "EMAIL").map(function (e) { return e.toLowerCase().trim(); }).filter(Boolean);
            var ek = getGroupKey(emails);
            if (ek) {
              if (!emailMap[ek]) emailMap[ek] = [];
              emailMap[ek].push(c.id);
            }
          }

          if (opts.customFieldCode) {
            var customVals = getCustomFieldValues(c, opts.customFieldCode);
            var ck = getGroupKey(customVals);
            if (ck) {
              if (!customMap[ck]) customMap[ck] = [];
              customMap[ck].push(c.id);
            }
          }
        });

        var processed = new Set(),
          groups = [];

        function addGroup(ids) {
          ids = ids.filter(function (id) { return !processed.has(id); });
          if (ids.length < 2) return;
          ids.sort(function (a, b) { return a - b; });
          ids.forEach(function (id) { processed.add(id); });
          groups.push({
            master_id: ids[0],
            ids: ids,
            contacts: ids.map(function (id) { return byId[id]; }).filter(Boolean)
          });
        }

        Object.keys(phoneMap).forEach(function (k) { addGroup(phoneMap[k]); });
        Object.keys(emailMap).forEach(function (k) {
          var ids = emailMap[k].filter(function (id) { return !processed.has(id); });
          if (ids.length >= 2) addGroup(ids);
        });
        Object.keys(customMap).forEach(function (k) {
          var ids = customMap[k].filter(function (id) { return !processed.has(id); });
          if (ids.length >= 2) addGroup(ids);
        });

        return groups;
      }

      // =============================================================
      // Слияние через нативный API v4 merge
      // =============================================================

      function mergeContacts(masterId, secondaryIds) {
        var queue = secondaryIds.slice();
        function mergeOne(remaining) {
          if (remaining.length === 0) return Promise.resolve({ merged: secondaryIds.length });
          var sid = remaining.shift();
          return apiCallWithRetry("POST", "/api/v4/contacts/merge", {
            merge_id: masterId,
            secondary_id: sid
          }).then(function () {
            return mergeOne(remaining);
          });
        }
        return mergeOne(queue);
      }

      // =============================================================
      // Уведомления
      // =============================================================

      function notify(msg, isErr) {
        var $n = $(
          '<div style="position:fixed;top:20px;right:20px;z-index:99999;padding:12px 20px;' +
          'border-radius:6px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.15);max-width:400px;"></div>'
        );
        $n.css("background", isErr ? "#ffebee" : "#e8f5e9");
        $n.css("color", isErr ? "#c62828" : "#2e7d32");
        $n.css("border", isErr ? "1px solid #ef9a9a" : "1px solid #a5d6a7");
        $n.text(msg);
        $("body").append($n);
        setTimeout(function () { $n.fadeOut(300, function () { $n.remove(); }); }, 4000);
      }

      // =============================================================
      // UI в карточке контакта
      // =============================================================

      function initCardUI() {
        var s = self.get_settings();
        var wCode = self.params.widget_code;
        var basePath = self.params.path;

        var html =
          '<div class="adu2-card" style="padding:12px 15px;font-size:13px;line-height:1.5;">' +
          '<div style="font-weight:600;font-size:14px;margin-bottom:10px;color:#333;">' +
          langs.interface.scan_button + '</div>';

        if (!s.api_token) {
          html +=
            '<p style="color:#888;margin:0 0 10px;">Укажите API токен в настройках</p>' +
            '<button class="adu2-settings-btn" style="width:100%;padding:8px;font-size:13px;' +
            'cursor:pointer;border:1px solid #ddd;border-radius:4px;background:#f5f5f5;color:#555;">' +
            langs.interface.settings_btn + '</button>';
        } else if (s.compare_phone !== "Y" && s.compare_email !== "Y" && !s.custom_field_code) {
          html +=
            '<p style="color:#888;margin:0 0 10px;">' + langs.interface.not_configured + '</p>' +
            '<button class="adu2-settings-btn" style="width:100%;padding:8px;font-size:13px;' +
            'cursor:pointer;border:1px solid #ddd;border-radius:4px;background:#f5f5f5;color:#555;">' +
            langs.interface.settings_btn + '</button>';
        } else {
          html +=
            '<button class="adu2-scan-btn" style="width:100%;padding:8px;font-size:13px;cursor:pointer;' +
            'border:none;border-radius:4px;background:#4CAF50;color:#fff;margin-bottom:6px;">' +
            langs.interface.scan_button + '</button>' +
            '<button class="adu2-settings-btn" style="width:100%;padding:8px;font-size:13px;' +
            'cursor:pointer;border:1px solid #ddd;border-radius:4px;background:#f5f5f5;color:#555;">' +
            langs.interface.settings_btn + '</button>';
        }

        html += '</div>';

        var $body = $(".card-widgets__widget-" + wCode + " .card-widgets__widget__body");
        if (!$body.length) $body = $(".card-widgets__widget__body").first();
        if ($body.length) $body.html(html);

        $(".adu2-scan-btn").off().on("click", function () { doScan($(this)); });
        $(".adu2-settings-btn").off().on("click", function () { openSettingsModal(); });
      }

      // =============================================================
      // Сканирование
      // =============================================================

      function doScan($btn) {
        var s = self.get_settings();
        if (!s.api_token) { notify("Сначала укажите API токен", true); return; }

        $btn.prop("disabled", true).text(langs.interface.scanning);

        var opts = {
          comparePhone: s.compare_phone === "Y",
          compareEmail: s.compare_email === "Y",
          customFieldCode: s.custom_field_code || ""
        };

        fetchAll("contacts").then(function (contacts) {
          $btn.prop("disabled", false).text(langs.interface.scan_button);
          var groups = findDuplicateGroups(contacts, opts);
          if (!groups.length) {
            notify(langs.interface.no_duplicates, false);
            return;
          }
          showMergeModal(groups);
        }).catch(function (err) {
          $btn.prop("disabled", false).text(langs.interface.scan_button);
          notify((langs.interface.error_occurred) + ": " + (err.message || "статус " + err.status), true);
        });
      }

      // =============================================================
      // Модальное окно результатов слияния
      // =============================================================

      function showMergeModal(groups) {
        var html =
          '<div class="adu2-overlay"></div>' +
          '<div class="adu2-modal">' +
          '<h3 class="adu2-modal-title">' + langs.interface.found_groups + ' <span class="adu2-groups-count">' +
          groups.length + '</span></h3>' +
          '<div class="adu2-groups-list">';

        groups.forEach(function (g, idx) {
          html +=
            '<div class="adu2-group" data-idx="' + idx + '">' +
            '<div class="adu2-group-header">Группа ' + (idx + 1) + ' (' + g.ids.length + ' конт.)</div>';
          g.contacts.forEach(function (c) {
            var isMaster = c.id === g.master_id;
            html +=
              '<div class="adu2-contact' + (isMaster ? ' adu2-master' : '') + '">' +
              (c.name || "—") + ' (ID:' + c.id + ')' +
              (isMaster ? ' <span class="adu2-master-label">← ' + langs.interface.master_label + '</span>' : '') +
              '</div>';
          });
          html +=
            '<button class="adu2-merge-btn" data-idx="' + idx + '">' +
            langs.interface.merge_btn + '</button></div>';
        });

        html += '</div>' +
          '<div class="adu2-modal-footer">' +
          '<button class="adu2-close-btn">' + langs.interface.close_btn + '</button>' +
          '</div></div>';

        $("body").append(html);

        $(".adu2-close-btn, .adu2-overlay").on("click", function () {
          $(".adu2-modal, .adu2-overlay").remove();
        });

        $(".adu2-merge-btn").on("click", function () {
          var idx = parseInt($(this).data("idx"));
          var $btn = $(this);
          var $grp = $btn.closest(".adu2-group");
          $btn.prop("disabled", true).text(langs.interface.scanning);

          var g = groups[idx];
          var secondaryIds = g.ids.filter(function (id) { return id !== g.master_id; });

          mergeContacts(g.master_id, secondaryIds).then(function () {
            $btn.text("✅ " + langs.interface.merge_api_success);
            $grp.fadeOut(300);
            notify(langs.interface.merge_success, false);
          }).catch(function (err) {
            $btn.prop("disabled", false).text(langs.interface.merge_btn);
            notify((langs.interface.error_occurred) + ": " + (err.message || "статус " + err.status), true);
          });
        });
      }

      // =============================================================
      // Настройки (модальное окно)
      // =============================================================

      function openSettingsModal() {
        var s = self.get_settings();
        var comparePhone = s.compare_phone === "Y";
        var compareEmail = s.compare_email === "Y";
        var autoMerge = s.auto_merge === "Y";
        var apiToken = s.api_token || "";
        var customFieldCode = s.custom_field_code || "TELEGRAM_USERNAME_ID";

        var html =
          '<div class="adu2-overlay"></div>' +
          '<div class="adu2-modal adu2-settings-modal">' +
          '<h3 class="adu2-modal-title">Настройки</h3>' +
          '<div class="adu2-settings-body">' +
          '<div class="adu2-field-group"><label>API токен *</label>' +
          '<input type="text" class="adu2-token-input" value="' + apiToken.replace(/"/g, "&quot;") + '"></div>' +
          '<label class="adu2-checkbox-label"><input type="checkbox" class="adu2-chk-phone"' +
          (comparePhone ? ' checked' : '') + '> ' + langs.settings.compare_phone + '</label>' +
          '<label class="adu2-checkbox-label"><input type="checkbox" class="adu2-chk-email"' +
          (compareEmail ? ' checked' : '') + '> ' + langs.settings.compare_email + '</label>' +
          '<div class="adu2-field-group"><label>' + langs.settings.custom_field_code + '</label>' +
          '<input type="text" class="adu2-field-input" value="' + customFieldCode.replace(/"/g, "&quot;") + '"></div>' +
          '<label class="adu2-checkbox-label"><input type="checkbox" class="adu2-chk-auto"' +
          (autoMerge ? ' checked' : '') + '> ' + langs.settings.auto_merge + '</label>' +
          '</div>' +
          '<div class="adu2-modal-footer">' +
          '<button class="adu2-save-btn" style="background:#1976d2;color:#fff;border:none;padding:8px 20px;border-radius:4px;cursor:pointer;font-size:13px;">' +
          langs.settings.save_btn + '</button>' +
          '<button class="adu2-close-btn" style="padding:8px 20px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;font-size:13px;margin-left:6px;">' +
          langs.settings.cancel_btn + '</button>' +
          '</div></div>';

        $("body").append(html);

        $(".adu2-close-btn, .adu2-overlay").on("click", function () {
          $(".adu2-modal, .adu2-overlay").remove();
        });

        $(".adu2-save-btn").on("click", function () {
          var newToken = $(".adu2-token-input").val() || "";
          if (!newToken) {
            notify("API токен обязателен", true);
            return;
          }
          self.set_settings({
            api_token: newToken,
            compare_phone: $(".adu2-chk-phone").is(":checked") ? "Y" : "N",
            compare_email: $(".adu2-chk-email").is(":checked") ? "Y" : "N",
            custom_field_code: $(".adu2-field-input").val() || "",
            auto_merge: $(".adu2-chk-auto").is(":checked") ? "Y" : "N"
          });
          notify(langs.settings.saved, false);
          $(".adu2-modal, .adu2-overlay").remove();
          if (system.area === "ccard") initCardUI();
        });
      }

      // =============================================================
      // Callbacks виджета
      // =============================================================

      this.callbacks = {
        render: function () {
          if (system.area === "ccard") {
            if (typeof APP !== "undefined" && APP.data && APP.data.current_card && APP.data.current_card.id === 0) {
              return false;
            }
            initCardUI();
          }
          return true;
        },

        init: function () {
          return true;
        },

        bind_actions: function () {
          return true;
        },

        settings: function () {
          openSettingsModal();
          return true;
        },

        onSave: function () {
          return true;
        },

        destroy: function () {
          return true;
        },

        contacts: { selected: function () {} },
        leads: { selected: function () {} },
        todo: { selected: function () {} }
      };

      return this;
    } catch (e) {
      console.error("[Антидубль v2] КРИТИЧЕСКАЯ ОШИБКА:", e.message, e.stack);
      return this;
    }
  };
  return CustomWidget;
});
