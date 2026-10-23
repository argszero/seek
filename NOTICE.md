# NOTICE

## Relationship to Feishu (Lark)

This project is **not affiliated with, authorised by, endorsed by or sponsored by** Beijing Feishu Technology Co., Ltd. or any of its affiliates.

`prototype/` is a **visual reference implementation**: its colour values, type scale and icon appearance follow the look of the Feishu desktop client, in order to test whether that layout and density can support a local messenger. Specifically:

- The colour ramps and type sizes in `prototype/src/css/tokens.css` were derived by observing and measuring the Feishu desktop client's resources.
- The icons in `prototype/src/js/icons.js` are **drawn from scratch** in the same visual language (24×24 box, 1.6px stroke, round caps). No icon assets were extracted from the Feishu application.

The MIT license in this repository **covers only the code and text written by this project's authors**. It does not cover, and does not grant any right to use, any third party's trademarks, designs or interface assets. If you intend to ship a product publicly that reproduces this interface, check your own jurisdiction's rules on trade dress first.

## Where this project stands on cloning an interface

seek is not a replacement for Feishu, nor a compatible client: it does not connect to Feishu's network, read or write Feishu's data, or reuse Feishu's code. What it borrows is the general interaction grammar of instant messaging — a list on the left, a message stream, a composer, a side panel. What it does differently is the data model and the kernel: every contact is a long-lived agent rather than a person.

If a rights holder objects to the visual reference in `prototype/`, open an issue and the offending part will be removed or redrawn.
