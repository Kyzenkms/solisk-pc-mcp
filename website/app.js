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

// Ticker: duplicate the set once in JS so the CSS loop is seamless.
// No-JS still shows a single static set. Pure decoration.
const track = document.getElementById("tickerTrack");
if (track && !track.dataset.doubled) {
  track.dataset.doubled = "1";
  track.innerHTML += track.innerHTML;
}

// Motion: one hero entrance + scroll reveals. Everything guards on
// GSAP presence and no-preference motion; otherwise the page is static
// and fully visible (all animation uses from-states set here, never CSS).
(function () {
  if (!window.gsap || !window.ScrollTrigger) return;
  if (!window.matchMedia("(prefers-reduced-motion: no-preference)").matches) return;
  gsap.registerPlugin(ScrollTrigger);
  gsap.defaults({ duration: 0.7, ease: "power3.out" });

  const hero = gsap.utils.toArray("[data-hero]");
  if (hero.length) {
    gsap.from(hero, { y: 28, autoAlpha: 0, stagger: 0.12, delay: 0.1 });
  }

  const items = gsap.utils.toArray("[data-reveal]");
  if (items.length) {
    gsap.set(items, { y: 26, autoAlpha: 0 });
    ScrollTrigger.batch(items, {
      start: "top 88%",
      once: true,
      onEnter: (batch) => gsap.to(batch, { y: 0, autoAlpha: 1, stagger: 0.08 }),
    });
  }
})();
