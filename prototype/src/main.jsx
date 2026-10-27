/**
 * The prototype's renderer — **the window's own components, over a fixture.**
 *
 * There is no component below this line that the app does not also have. It imports
 * `ui/src/App.jsx` and the two stylesheets out of `ui/src/styles/`, which is the whole point
 * of the arrangement: a screen cannot drift from the app because there is only one screen,
 * and a stylesheet cannot drift because there is only one stylesheet.
 *
 * **What is supplied here and nowhere in the app** is the host: `window.seekHost` is faked
 * (`fake-host.js`) and the data behind it is invented (`fixture.js`). That is the only
 * difference between this page and a real window, and it is data, not drawing.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'

import App from '../../ui/src/App.jsx'
import { bindCatalogue } from '../../ui/src/catalogue.mjs'

import { fakeHost } from './fake-host.js'

// The window's two stylesheets, imported rather than copied. A prototype with its own
// `app.css` would be the second stylesheet this arrangement exists to delete.
import '../../ui/src/styles/tokens.css'
import '../../ui/src/styles/shell.css'

window.seekHost = fakeHost

/**
 * The same order the window boots in (`ui/src/main.jsx`), for the same two reasons: the
 * catalogue is bound before the first frame, because a window that drew a key or an English
 * default and then repainted is worse than one that waited; and the theme attribute is set
 * before it too, because both palettes live behind it and a dark window that painted light
 * first is the flash both of these exist to avoid.
 */
Promise.all([fakeHost.catalogue(), fakeHost.theme()]).then(([catalogue, theme]) => {
  bindCatalogue(catalogue)
  // **The page says which language it is in.** `index.html` is static and cannot know: this demo
  // renders English unless `?locale=` asks for another, so the attribute was left claiming
  // `zh-CN` over English words — read aloud, that is a lie about the text.
  document.documentElement.setAttribute('lang', catalogue.locale)
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light')
  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
