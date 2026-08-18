const toggle = document.querySelector(".nav-toggle");
const links = document.querySelector(".nav-links");

toggle?.addEventListener("click", () => {
  const open = links.classList.toggle("open");
  toggle.setAttribute("aria-expanded", String(open));
});

links?.addEventListener("click", (event) => {
  if (event.target.closest("a")) {
    links.classList.remove("open");
    toggle?.setAttribute("aria-expanded", "false");
  }
});

document.querySelectorAll("[data-year]").forEach((node) => {
  node.textContent = new Date().getFullYear();
});

const loader = document.querySelector(".skeleton-loader");
const skipIntro = new URLSearchParams(window.location.search).has("skipIntro");
if (loader) {
  let removed = false;
  const removeLoader = () => {
    if (removed) return;
    removed = true;
    loader.classList.add("leaving");
    setTimeout(() => loader.remove(), 180);
  };

  if (
    skipIntro ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    loader.remove();
  } else {
    const started = performance.now();
    const finish = () => {
      const minimumDisplay = Math.max(0, 650 - (performance.now() - started));
      setTimeout(removeLoader, minimumDisplay);
    };
    if (document.readyState === "complete") finish();
    else window.addEventListener("load", finish, { once: true });
    setTimeout(removeLoader, 1100);
  }
}
