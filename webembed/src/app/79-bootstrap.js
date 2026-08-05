  window.addEventListener("hashchange", renderRoute);
  WORKLOAD_FILTER_DESKTOP_MEDIA.addEventListener("change", event => {
    const disclosure = document.querySelector(".workload-filter-disclosure");
    if (disclosure) disclosure.open = event.matches;
  });
  renderRoute();
})();
