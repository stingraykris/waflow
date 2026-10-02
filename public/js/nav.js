(function () {
  // Keep the top-level row short - the rest live under "More" so the bar
  // doesn't crowd/wrap once Admin gets added in for admin accounts.
  const PRIMARY_LINKS = [
    { href: "/", label: "Home", icon: "fa-house" },
    { href: "/queue", label: "Queue", icon: "fa-list-check" },
    { href: "/flows", label: "Flows", icon: "fa-diagram-project" },
    { href: "/flow-log", label: "Flow Log", icon: "fa-clipboard-list" },
    { href: "/safety", label: "Safety", icon: "fa-shield-halved" },
  ];
  const SECONDARY_LINKS = [
    { href: "/number-verify", label: "Verify Numbers", icon: "fa-check-circle" },
    { href: "/templates", label: "Templates", icon: "fa-file-lines" },
    { href: "/blocklist", label: "Blocklist", icon: "fa-ban" },
    { href: "/integrations", label: "Integrations", icon: "fa-plug" },
    { href: "/api-settings", label: "API Settings", icon: "fa-key" },
  ];

  function linkHtml(l, path) {
    const active = path === l.href ? " active" : "";
    return `<a href="${l.href}" class="${active.trim()}"><i class="fa ${l.icon} me-1"></i>${l.label}</a>`;
  }

  function renderNav(me) {
    const secondary = SECONDARY_LINKS.slice();
    if (me && me.isAdmin) {
      secondary.push({ href: "/admin", label: "Admin", icon: "fa-user-shield" });
    }

    const path = window.location.pathname;
    const primaryHtml = PRIMARY_LINKS.map((l) => linkHtml(l, path)).join("");
    const secondaryHtml = secondary.map((l) => linkHtml(l, path)).join("");
    const moreActive = secondary.some((l) => l.href === path);

    const html = `
      <nav class="app-topbar">
        <div class="app-topbar-inner">
          <a href="/" class="app-brand"><span class="wa-text">WA</span><span class="flow-text">FLOW</span></a>
          <button type="button" class="app-nav-toggle" aria-label="Toggle navigation">
            <i class="fa fa-bars"></i>
          </button>
          <div class="app-nav-links">
            ${primaryHtml}
            <div class="app-nav-more">
              <button type="button" class="app-nav-more-btn${moreActive ? " active" : ""}">
                More <i class="fa fa-chevron-down ms-1" style="font-size: 0.7em"></i>
              </button>
              <div class="app-nav-more-menu">${secondaryHtml}</div>
            </div>
          </div>
          <div class="app-user">
            ${me?.name ? `<span class="app-user-name">${me.name}</span>` : ""}
            <a href="/logout" class="app-logout"><i class="fa fa-sign-out-alt me-1"></i>Logout</a>
          </div>
        </div>
      </nav>
    `;

    const mount = document.getElementById("app-nav");
    if (!mount) return;

    const wrapper = document.createElement("div");
    wrapper.innerHTML = html.trim();
    const navEl = wrapper.firstElementChild;

    // Preserve any extra classes the page put on the placeholder (e.g.
    // "no-print" on flow-log.html's print view).
    mount.classList.forEach((cls) => navEl.classList.add(cls));
    mount.replaceWith(navEl);

    wireInteractions(navEl);
  }

  function wireInteractions(navEl) {
    const moreBtn = navEl.querySelector(".app-nav-more-btn");
    const moreMenu = navEl.querySelector(".app-nav-more-menu");
    const mobileToggle = navEl.querySelector(".app-nav-toggle");
    const navLinks = navEl.querySelector(".app-nav-links");

    moreBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      moreMenu.classList.toggle("open");
    });

    mobileToggle.addEventListener("click", () => {
      navLinks.classList.toggle("open");
    });

    document.addEventListener("click", (ev) => {
      if (!navEl.contains(ev.target)) {
        moreMenu.classList.remove("open");
      }
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") moreMenu.classList.remove("open");
    });
  }

  fetch("/api/me")
    .then((res) => (res.ok ? res.json() : null))
    .then(renderNav)
    .catch(() => renderNav(null));
})();
