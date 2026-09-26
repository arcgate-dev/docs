// arcgate docs: tutorial pages (issue #55). Copy-to-clipboard on every code block, and a
// dark-mode toggle that shares the reference's localStorage "colorMode" key.
(function () {
  var root = document.documentElement;
  var live = document.querySelector("[data-ag-live]");
  var themeColors = document.querySelectorAll('meta[name="theme-color"]');

  function announce(text) {
    if (!live) return;
    live.textContent = "";
    // Force a DOM mutation so repeated identical announcements still fire.
    window.setTimeout(function () {
      live.textContent = text;
    }, 30);
  }

  function setDark(dark) {
    root.classList.toggle("ag-dark", dark);
    try {
      localStorage.setItem("colorMode", dark ? "dark" : "light");
    } catch (e) {}
    for (var i = 0; i < themeColors.length; i++) {
      themeColors[i].setAttribute("content", dark ? "#101815" : "#EEF1EB");
    }
    var toggle = document.querySelector("[data-ag-mode-toggle]");
    var label = document.querySelector("[data-ag-mode-label]");
    if (toggle) toggle.setAttribute("aria-pressed", String(dark));
    if (label) label.textContent = dark ? "Light" : "Dark";
  }

  var toggle = document.querySelector("[data-ag-mode-toggle]");
  if (toggle) {
    setDark(root.classList.contains("ag-dark"));
    toggle.addEventListener("click", function () {
      setDark(!root.classList.contains("ag-dark"));
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
    return Promise.resolve();
  }

  var buttons = document.querySelectorAll("[data-copy]");
  for (var i = 0; i < buttons.length; i++) {
    (function (button) {
      button.addEventListener("click", function () {
        var code = button.closest(".ag-tut-code").querySelector("code");
        var text = code ? code.textContent : "";
        copyText(text).then(function () {
          var original = button.textContent;
          button.textContent = "Copied";
          announce("Copied");
          window.setTimeout(function () {
            button.textContent = original;
          }, 1500);
        });
      });
    })(buttons[i]);
  }
})();
