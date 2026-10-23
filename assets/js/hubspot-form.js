(() => {
  const root = document.querySelector("[data-s46-hubspot]");
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = "true";

  const target = root.querySelector("[data-form-target]");
  const status = root.querySelector("[data-form-status]");
  const button = root.querySelector("[data-load-form]");
  let started = false;
  let timer;

  window.addEventListener("hs-form-event:on-ready", (event) => {
    if (event.detail?.formId !== target.dataset.formId) return;
    clearTimeout(timer);
    status.hidden = true;
    root.dataset.ready = "true";
  });

  const load = () => {
    if (started) return;
    started = true;
    if (button) button.hidden = true;
    status.hidden = false;
    // Add the official selector only after the reviewer chooses to connect.
    target.classList.add("hs-form-frame");
    const script = document.createElement("script");
    script.src = "https://js-na2.hsforms.net/forms/embed/242183160.js";
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      status.textContent =
        "The enquiry form could not load. Please use the email address below.";
    };
    timer = setTimeout(() => {
      status.textContent =
        "The enquiry form is taking longer to load. You can also use the email address below.";
    }, 20000);
    root.appendChild(script);
  };

  if (root.dataset.review === "true") {
    button.addEventListener("click", load);
  } else {
    load();
  }
})();
