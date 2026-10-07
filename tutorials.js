// arcgate docs: the tutorials index (issue #55). A dark-mode toggle that shares the reference's
// localStorage "colorMode" key.
(function () {
  var root = document.documentElement;
  var themeColors = document.querySelectorAll('meta[name="theme-color"]');

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
})();
