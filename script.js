define(["jquery"], function ($) {
  var CustomWidget = function () {
    var self = this,
      system = self.system(),
      langs = self.langs;

    this.callbacks = {
      render: function () {
        if (system.area === "ccard") {
          var wCode = self.params.widget_code;
          var html = '<div style="padding:12px;font-size:13px;color:#333;">Антидубль v2 загружен ✅</div>';
          var $body = $(".card-widgets__widget-" + wCode + " .card-widgets__widget__body");
          if (!$body.length) $body = $(".card-widgets__widget__body").first();
          if ($body.length) $body.html(html);
        }
        return true;
      },
      init: function () { return true; },
      bind_actions: function () { return true; },
      settings: function () { return true; },
      onSave: function () { return true; },
      destroy: function () { return true; },
      contacts: { selected: function () {} },
      leads: { selected: function () {} },
      todo: { selected: function () {} }
    };
    return this;
  };
  return CustomWidget;
});
