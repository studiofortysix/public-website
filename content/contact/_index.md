---
title: "Get in Touch"
description: "Let’s talk data, dashboards, or that GA4 setup you’re sick of looking at."
draft: false
---

## Let’s Make This Easy

I work with marketing managers and agencies across NZ (and beyond).  
Use the form below to get in touch — and I’ll usually reply within 1 business day.

<div style="margin-top:2rem">
  <div id="hs-form-container">
    <p>Loading contact form…</p>
  </div>
</div>

<script>
  document.addEventListener('DOMContentLoaded', function () {
    const target = document.getElementById('hs-form-container');
    if (!target) return;

    const loadForm = () => {
      if (target.dataset.loaded) return;
      target.dataset.loaded = 'true';

      const s = document.createElement('script');
      s.src = "https://js.hsforms.net/forms/v2.js";
      s.onload = function () {
        if (window.hbspt) {
          window.hbspt.forms.create({
            portalId: "242183160",
            formId: "bcadce91-e864-465a-b098-ed0207be334c",
            target: "#hs-form-container"
          });
        }
      };
      document.body.appendChild(s);
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          loadForm();
          observer.disconnect();
        }
      });
    });

    observer.observe(target);
  });
</script>