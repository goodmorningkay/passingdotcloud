"use client";

import { useEffect, useRef } from "react";
import { startSky } from "./sky-effects";
import styles from "./sky.module.css";

export function Sky() {
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!layer.current) return;
    const sky = startSky(layer.current, styles);
    return () => sky.stop();
  }, []);

  return (
    <div className={styles.sky} ref={layer} aria-hidden="true">
      <svg className={styles.definitions} focusable="false">
        <defs>
          <symbol id="sky-cloud-wide" viewBox="0 0 420 180">
            <path
              fill="currentColor"
              d="M66 146C35 146 16 131 16 111C16 91 32 77 52 77C58 53 79 38 105 41C117 16 140 5 168 11C194 17 209 37 211 61C227 49 247 49 264 58C279 42 298 37 318 44C340 51 353 70 354 91C381 87 405 100 405 119C405 138 384 146 357 146Z"
            />
            <path
              fill="var(--cloud-shade)"
              d="M16 112C29 130 52 133 78 133H346C372 133 394 128 405 118V119C405 138 384 146 357 146H66C35 146 16 131 16 112Z"
            />
          </symbol>
          <symbol id="sky-cloud-round" viewBox="0 0 420 180">
            <path
              fill="currentColor"
              d="M77 151C42 151 19 137 19 113C19 90 37 74 63 76C67 49 87 31 113 34C126 9 152 1 178 10C200 18 213 37 215 57C228 43 248 39 267 45C291 53 305 72 304 94C315 84 328 81 342 85C359 89 370 100 372 114C390 115 400 123 400 133C400 145 383 151 360 151Z"
            />
            <path
              fill="var(--cloud-shade)"
              d="M20 117C35 136 64 137 90 137H352C373 137 390 133 398 128C408 142 386 151 360 151H77C45 151 24 139 20 117Z"
            />
          </symbol>
          <symbol id="sky-cloud-small" viewBox="0 0 420 180">
            <path
              fill="currentColor"
              d="M78 147C52 147 37 135 37 119C37 102 53 91 74 92C77 70 94 55 116 58C126 34 147 20 174 25C198 29 212 47 215 67C230 58 246 58 260 66C274 58 289 59 302 67C317 76 323 89 322 104C346 101 364 109 364 123C364 138 344 147 317 147Z"
            />
            <path
              fill="var(--cloud-shade)"
              d="M38 123C54 135 72 136 95 136H309C333 136 352 132 363 124C363 138 344 147 317 147H78C55 147 41 137 38 123Z"
            />
          </symbol>
        </defs>
      </svg>
      <div className={styles.stars} data-stars />
      <div className={styles.sun} data-body />
      <svg
        className={styles.moon}
        viewBox="0 0 80 80"
        focusable="false"
        data-body
      >
        <defs>
          <mask
            id="sky-moon-cutout"
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="80"
            height="80"
          >
            <circle cx="40" cy="40" r="34" fill="white" />
            <circle cx="53" cy="27" r="32" fill="black" />
          </mask>
        </defs>
        <circle
          cx="40"
          cy="40"
          r="34"
          fill="currentColor"
          mask="url(#sky-moon-cutout)"
        />
      </svg>
      <div className={styles.clouds} data-clouds />
    </div>
  );
}
