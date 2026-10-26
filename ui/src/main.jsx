import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { bindCatalogue } from './catalogue.mjs'
import './styles/tokens.css'
import './styles/shell.css'

// **The first render waits for the words.** `catalogue.mjs` refuses to answer a lookup before
// `bindCatalogue()` has run — that refusal is the point (`docs/design/i18n.md` §1: a window
// that drew a key, or an English default, would look like a placeholder somebody meant to
// finish) — and this page's first frame is a sentence of its own ("opening the store…"). Asked
// a frame too early it threw, React unmounted the tree, and the window sat empty for as long
// as the store took: measured in a real window, not assumed, and pinned by
// `electron/catalogue.test.mjs` so the order cannot move back.
// The store is the slow half and still arrives later, so the booting line is still drawn —
// under a catalogue that exists.
window.seekHost.catalogue().then((catalogue) => {
  bindCatalogue(catalogue)
  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
