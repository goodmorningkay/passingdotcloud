// Sky palettes, cloud shapes, and spacing follow the original passing.cloud placeholder.
const colors = [
  "sky-top",
  "sky-middle",
  "sky-low",
  "sky-bottom",
  "cloud-color",
  "cloud-shade",
  "sun-color",
];
const night = {
  colors: [
    "#101a31",
    "#1b2943",
    "#2b3c55",
    "#43536a",
    "#586981",
    "#4a5a72",
    "#f8f3d9",
  ],
  sun: 0,
  moon: 0.96,
  stars: 1,
};
const dawn = {
  colors: [
    "#728dad",
    "#b9b5cc",
    "#ead0c5",
    "#f1dfc4",
    "#f4e8e0",
    "#dcd3d9",
    "#ffe4b8",
  ],
  sun: 0.83,
  moon: 0,
  stars: 0,
};
const day = {
  colors: [
    "#88bad5",
    "#afcfdf",
    "#ccdee2",
    "#e5e7dc",
    "#fafbf4",
    "#e7eff0",
    "#f8f3d9",
  ],
  sun: 0.83,
  moon: 0,
  stars: 0,
};
const sunset = {
  colors: [
    "#6a7c9c",
    "#b9a1b2",
    "#e8baab",
    "#f2cfab",
    "#e8d6d3",
    "#cbbac5",
    "#ffe0ac",
  ],
  sun: 0.9,
  moon: 0,
  stars: 0,
};
const twilight = {
  colors: [
    "#273757",
    "#5f6381",
    "#a4879b",
    "#d8b1a3",
    "#8485a1",
    "#74768f",
    "#ffe0ac",
  ],
  sun: 0,
  moon: 0,
  stars: 0.25,
};
const stops = [
  { hour: 0, ...night },
  { hour: 5, ...night },
  { hour: 6, ...dawn, sun: 0, stars: 0.08 },
  { hour: 7, ...dawn },
  { hour: 8, ...day },
  { hour: 17, ...day },
  { hour: 18, ...sunset },
  { hour: 19, ...twilight },
  { hour: 20, ...night },
  { hour: 24, ...night },
];
const random = (min: number, max: number) => min + Math.random() * (max - min);
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function mixColor(from: string, to: string, amount: number) {
  return (
    "#" +
    [1, 3, 5]
      .map((offset) => {
        const a = parseInt(from.slice(offset, offset + 2), 16);
        const b = parseInt(to.slice(offset, offset + 2), 16);
        return Math.round(a + (b - a) * amount)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}

export function startSky(
  layer: HTMLDivElement,
  styles: Record<string, string>,
) {
  const root = document.documentElement;
  const cloudLayer = layer.querySelector<HTMLDivElement>("[data-clouds]")!;
  const stars = layer.querySelector<HTMLDivElement>("[data-stars]")!;
  const active = new Map<HTMLDivElement, Animation>();
  const retries = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  let generation = 0;
  let space = {
    width: 0,
    height: 0,
    minWidth: 0,
    maxWidth: 0,
    gap: 0,
    speed: 0,
  };
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  function updatePalette() {
    const now = new Date();
    const hour =
      now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
    const next = stops.findIndex((stop) => stop.hour > hour);
    const from = stops[next - 1]!;
    const to = stops[next]!;
    const amount = (hour - from.hour) / (to.hour - from.hour);
    colors.forEach((name, index) => {
      root.style.setProperty(
        `--${name}`,
        mixColor(from.colors[index]!, to.colors[index]!, amount),
      );
    });
    for (const body of ["sun", "moon", "stars"] as const) {
      root.style.setProperty(
        `--${body}-opacity`,
        String(from[body] + (to[body] - from[body]) * amount),
      );
    }
    root.dataset.skyTheme = hour < 6.5 || hour >= 18.5 ? "night" : "day";
  }

  for (const body of layer.querySelectorAll<HTMLElement | SVGElement>(
    "[data-body]",
  )) {
    body.style.setProperty("--body-x", `${random(16, 84)}%`);
    body.style.setProperty("--body-y", `${random(12, 28)}%`);
  }
  const starPositions = Array.from({ length: 96 }, (_, index) => ({
    x: (((index % 12) + random(0.2, 0.8)) / 12) * 100,
    y: 3 + ((Math.floor(index / 12) + random(0.2, 0.8)) / 8) * 82,
    size: random(0.8, 2.2),
    opacity: random(0.32, 0.88),
  }));
  for (let index = starPositions.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [starPositions[index], starPositions[other]] = [
      starPositions[other]!,
      starPositions[index]!,
    ];
  }

  function findSpace(initial: boolean) {
    const occupied = [...active.keys()].map((element) =>
      element.getBoundingClientRect(),
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      const width = random(space.minWidth, space.maxWidth);
      const height = (width * 180) / 420;
      const x = initial
        ? random(-width * 0.35, space.width - width * 0.6)
        : -width - space.gap;
      const y = random(space.gap / 2, space.height - height - space.gap / 2);
      if (
        occupied.every(
          (other) =>
            x + width + space.gap <= other.left ||
            other.right + space.gap <= x ||
            y + height + space.gap <= other.top ||
            other.bottom + space.gap <= y,
        )
      )
        return { x, y, width };
    }
    return null;
  }

  function addCloud(initial: boolean, version: number) {
    if (stopped || version !== generation) return;
    const position = findSpace(initial);
    if (!position) {
      const timer = setTimeout(() => {
        retries.delete(timer);
        addCloud(false, version);
      }, 1000);
      retries.add(timer);
      return;
    }
    const cloud = document.createElement("div");
    cloud.className = styles.cloud!;
    cloud.style.top = `${position.y}px`;
    cloud.style.width = `${position.width}px`;
    cloud.style.opacity = String(random(0.55, 0.96));
    cloud.style.transform = `translate3d(${position.x}px, 0, 0)`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 420 180");
    svg.setAttribute("focusable", "false");
    if (Math.random() < 0.5) svg.style.transform = "scaleX(-1)";
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "use");
    const shapes = ["sky-cloud-wide", "sky-cloud-round", "sky-cloud-small"];
    shape.setAttribute(
      "href",
      `#${shapes[Math.floor(Math.random() * shapes.length)]}`,
    );
    svg.append(shape);
    cloud.append(svg);
    cloudLayer.append(cloud);
    const destination = space.width + space.gap;
    const animation = cloud.animate(
      [
        { transform: `translate3d(${position.x}px, 0, 0)` },
        { transform: `translate3d(${destination}px, 0, 0)` },
      ],
      {
        duration: ((destination - position.x) / space.speed) * 1000,
        easing: "linear",
        fill: "forwards",
      },
    );
    active.set(cloud, animation);
    animation.onfinish = () => {
      active.delete(cloud);
      cloud.remove();
      addCloud(false, version);
    };
  }

  function clearClouds() {
    retries.forEach(clearTimeout);
    retries.clear();
    active.forEach((animation, cloud) => {
      animation.onfinish = null;
      animation.cancel();
      cloud.remove();
    });
    active.clear();
  }

  function fillSky() {
    const width = layer.clientWidth;
    const height = layer.clientHeight;
    if (!width || !height || (width === space.width && height === space.height))
      return;
    generation++;
    clearClouds();
    const maxWidth = Math.min(
      480,
      width * (width < 600 ? 0.58 : 0.32),
      height * 0.64,
    );
    space = {
      width,
      height,
      maxWidth,
      minWidth: Math.min(maxWidth * 0.65, Math.max(90, width * 0.12)),
      gap: clamp(Math.min(width, height) * 0.05, 24, 52),
      speed: clamp(width / 145, 4.5, 13),
    };
    const fragment = document.createDocumentFragment();
    const count = clamp(Math.round((width * height) / 18000), 24, 96);
    for (const position of starPositions.slice(0, count)) {
      const star = document.createElement("span");
      star.className = styles.star!;
      star.style.left = `${position.x}%`;
      star.style.top = `${position.y}%`;
      star.style.setProperty("--star-size", `${position.size}px`);
      star.style.opacity = String(position.opacity);
      fragment.append(star);
    }
    stars.replaceChildren(fragment);
    const cloudCount = clamp(Math.round((width * height) / 190000) + 4, 6, 12);
    for (let index = 0; index < cloudCount; index++) addCloud(true, generation);
  }
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fillSky, 160);
  }
  function onVisibility() {
    if (!document.hidden) updatePalette();
  }
  updatePalette();
  fillSky();
  const paletteTimer = setInterval(updatePalette, 30_000);
  window.addEventListener("resize", onResize);
  window.addEventListener("focus", updatePalette);
  window.addEventListener("pageshow", updatePalette);
  document.addEventListener("visibilitychange", onVisibility);
  return {
    stop() {
      stopped = true;
      clearClouds();
      stars.replaceChildren();
      clearInterval(paletteTimer);
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("focus", updatePalette);
      window.removeEventListener("pageshow", updatePalette);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
