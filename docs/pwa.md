# Home Screen app

On iPhone or iPad, open the site in Safari. In Share, select **Add to Home
Screen**. If Safari shows **Open as Web App**, leave it on and select **Add**.

The app opens at the upload page. Transfers require a network connection.
Keep the app open and the screen on during a transfer.

## App details

`app/manifest.ts` sets the app identity, scope, and launch page to `/`. The
app uses no service worker or offline transfer cache. The Install link is
hidden in standalone mode. Pages keep their CSP nonces and `no-store` headers.

## Icons

After you change `app/icon.svg`, regenerate the PNGs.

```sh
node scripts/generate-pwa-icons.mjs
```

The script writes `app/apple-icon.png` and the manifest icons in
`public/icons/`. It makes the icons opaque so the OS can apply the corner
shape.

## Verify

After a production build, run `npm run test:e2e -- pwa.spec.ts`. The tests
check page metadata, icons, the launch page, and help without JavaScript
in Chromium and WebKit.

Use Safari on an iPhone or iPad to check the installation menu and the
Home Screen icon. Open the app and check portrait, landscape, and pinch zoom.
Upload a file, open the full link in Safari, and compare the downloaded file.
Check that the upload tab can delete the file. Quit and reopen the app to
verify that it starts at the upload page.
