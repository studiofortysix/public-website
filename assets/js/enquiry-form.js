(() => {
  const form = document.querySelector("[data-s46-enquiry]");
  if (!form || form.dataset.initialized) return;
  form.dataset.initialized = "true";

  const button = form.querySelector("[data-submit-enquiry]");
  const buttonText = form.querySelector("[data-button-text]");
  const result = form.querySelector("[data-form-result]");
  const email = form.elements.email;
  const emailError = form.querySelector("#enquiry-email-error");
  const review = form.dataset.review === "true";
  const live =
    !review && form.dataset.enabled === "true" && !!form.dataset.sitekey;
  const startedAt = Date.now();
  let widgetId;
  let token = "";
  let busy = false;
  let sent = false;
  let locked = false;

  const message = (text, state = "info") => {
    result.textContent = text;
    result.dataset.state = state;
    result.hidden = false;
  };
  const updateButton = () => {
    button.disabled = busy || sent || locked || (!review && (!live || !token));
    buttonText.textContent = busy
      ? "Sending…"
      : sent
        ? "Enquiry sent"
        : locked
          ? "Please email to confirm"
          : "Send enquiry";
    form.setAttribute("aria-busy", String(busy));
  };
  const validate = () => {
    const valid = email.validity.valid && !!email.value.trim();
    emailError.textContent = valid ? "" : "Please enter a valid email address.";
    emailError.hidden = valid;
    email.setAttribute("aria-invalid", String(!valid));
    if (!valid) email.focus();
    return valid;
  };
  email.addEventListener("input", () => {
    if (email.getAttribute("aria-invalid") === "true") validate();
  });

  const resetSpamCheck = () => {
    token = "";
    if (widgetId !== undefined && window.turnstile)
      window.turnstile.reset(widgetId);
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || sent || locked || !validate()) return;
    // Portable/local review never transmits entered data or creates a CRM record.
    if (review) {
      message("Preview checked. No enquiry has been sent.");
      result.focus();
      return;
    }
    if (!live || !token) {
      message(
        "The form is not ready. Please wait for the spam check, or use the email address below.",
        "error",
      );
      return;
    }
    const payload = {
      firstname: form.elements.firstname.value.trim(),
      lastname: form.elements.lastname.value.trim(),
      email: email.value.trim(),
      enquiry: form.elements.enquiry.value.trim(),
      website: form.elements.website.value,
      turnstileToken: token,
      startedAt,
    };
    busy = true;
    updateButton();
    let uncertain = false;
    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25000),
      });
      const body =
        response.status === 429
          ? { code: "RATE_LIMITED" }
          : await response.json();
      const code =
        response.ok && body.accepted !== true
          ? "DELIVERY_UNCONFIRMED"
          : String(body.code || "").toUpperCase();
      if (response.ok && body.accepted === true) {
        sent = true;
        message("Thank you. Your enquiry has been received.", "success");
        // Keep the submitted values visible and prevent an accidental repeat.
      } else {
        message(
          code === "RATE_LIMITED"
            ? "Too many attempts. Please wait a minute before trying again."
            : code === "INVALID_REQUEST"
              ? "Please check your details and try again."
              : code === "VERIFICATION_FAILED"
                ? "The spam check could not be completed. Please try again."
                : code === "DELIVERY_UNCONFIRMED"
                  ? "We could not confirm delivery. Please email Warrick before trying again."
                  : "Your enquiry could not be sent. Please use the email address below.",
          "error",
        );
        uncertain = code === "DELIVERY_UNCONFIRMED";
      }
    } catch {
      uncertain = true;
      message(
        "We could not confirm delivery. Please email Warrick before trying again.",
        "error",
      );
    } finally {
      busy = false;
      locked = uncertain;
      // Tokens are single-use. Every retry must obtain a fresh token.
      resetSpamCheck();
      updateButton();
      result.focus();
    }
  });

  if (review) {
    updateButton();
    return;
  }
  if (!live || location.protocol !== "https:") {
    message(
      "The enquiry form is currently unavailable. Please use the email address below.",
    );
    return;
  }

  window.studio46TurnstileReady = () => {
    if (sent || locked) return;
    widgetId = window.turnstile.render(
      form.querySelector("[data-spam-check]"),
      {
        sitekey: form.dataset.sitekey,
        action: "contact",
        theme: document.documentElement.classList.contains("dark")
          ? "dark"
          : "light",
        size: "flexible",
        callback: (value) => {
          if (sent || locked) return;
          token = value;
          updateButton();
        },
        "expired-callback": () => {
          if (sent || locked) return;
          token = "";
          updateButton();
        },
        "error-callback": () => {
          if (sent || locked) return;
          token = "";
          updateButton();
          message(
            "The spam check could not load. Please refresh the page or use the email address below.",
            "error",
          );
        },
      },
    );
  };
  const script = document.createElement("script");
  script.src =
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=studio46TurnstileReady";
  script.async = true;
  script.defer = true;
  script.onerror = () => {
    if (sent || locked) return;
    message(
      "The spam check could not load. Please use the email address below.",
      "error",
    );
  };
  form.appendChild(script);
})();
