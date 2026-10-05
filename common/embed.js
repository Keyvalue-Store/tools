// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Inside a frame on keyvaluestore.com the site shows its own header, so the
// page hides its app bar. tool.css does the hiding.
if (window.self !== window.top) document.documentElement.className += ' embedded';
