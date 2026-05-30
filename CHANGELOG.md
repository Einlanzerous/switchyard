# Changelog

## [2.28.2](https://github.com/Einlanzerous/switchyard/compare/v2.28.1...v2.28.2) (2026-05-30)


### Bug Fixes

* SWY-84 — collapse rules-engine close/release twins in activity feed ([#68](https://github.com/Einlanzerous/switchyard/issues/68)) ([cb8ed4f](https://github.com/Einlanzerous/switchyard/commit/cb8ed4f1fcf8da6b85e0c9edebe1c7db11c54f98))

## [2.28.1](https://github.com/Einlanzerous/switchyard/compare/v2.28.0...v2.28.1) (2026-05-30)


### Bug Fixes

* SWY-84 — de-dupe activity feed (collapse "moved" under close) ([#66](https://github.com/Einlanzerous/switchyard/issues/66)) ([cccad52](https://github.com/Einlanzerous/switchyard/commit/cccad524a6168f40c594dea0de103b7117be6b50))

## [2.28.0](https://github.com/Einlanzerous/switchyard/compare/v2.27.0...v2.28.0) (2026-05-28)


### Features

* SWY-68 — MCP status admin + label CRUD tools ([#64](https://github.com/Einlanzerous/switchyard/issues/64)) ([0ea2c3c](https://github.com/Einlanzerous/switchyard/commit/0ea2c3c7b1da034dd96e5490087a8eabfc2ea1e4))

## [2.27.0](https://github.com/Einlanzerous/switchyard/compare/v2.26.0...v2.27.0) (2026-05-27)


### Features

* SWY-79 — unify status-category color palette ([#63](https://github.com/Einlanzerous/switchyard/issues/63)) ([f583faa](https://github.com/Einlanzerous/switchyard/commit/f583faa9c314f79cf22822c9ef2d9cd6e172efab))
* SWY-80 — MCP tools for external_refs CRUD ([#61](https://github.com/Einlanzerous/switchyard/issues/61)) ([b70f53b](https://github.com/Einlanzerous/switchyard/commit/b70f53bdb71d764084fed82ce114fe8f425757ab))

## [2.26.0](https://github.com/Einlanzerous/switchyard/compare/v2.25.0...v2.26.0) (2026-05-26)


### Features

* SWY-77 — divider above Comments, newest-first order, composer on top ([#59](https://github.com/Einlanzerous/switchyard/issues/59)) ([2eadcc0](https://github.com/Einlanzerous/switchyard/commit/2eadcc0788b8eef4391e589a11a9e54817c8c155))

## [2.25.0](https://github.com/Einlanzerous/switchyard/compare/v2.24.0...v2.25.0) (2026-05-26)


### Features

* SWY-75 — project-level default_test_cmd + pipeline-relevant MCP surface ([#57](https://github.com/Einlanzerous/switchyard/issues/57)) ([a28f11a](https://github.com/Einlanzerous/switchyard/commit/a28f11a9aae610d1f514537dcb404d7136ac15f5))
* SWY-76 — MCP tools for ticket links (blocks / relates_to / duplicates) ([#58](https://github.com/Einlanzerous/switchyard/issues/58)) ([4c80a4a](https://github.com/Einlanzerous/switchyard/commit/4c80a4a2c58bed7fcc1d38e07156fd428fb0dea3))


### Bug Fixes

* SWY-62 — pass bootstrapToken to seed() instead of reading cached env ([#55](https://github.com/Einlanzerous/switchyard/issues/55)) ([1e97b2b](https://github.com/Einlanzerous/switchyard/commit/1e97b2b76502b7057691cfba8fa89c724aa5ed76))

## [2.24.0](https://github.com/Einlanzerous/switchyard/compare/v2.23.1...v2.24.0) (2026-05-24)


### Features

* SWY-71 — dashboard IA: profile-menu My tickets, theme in Settings, leaner home ([#51](https://github.com/Einlanzerous/switchyard/issues/51)) ([4e8ec3f](https://github.com/Einlanzerous/switchyard/commit/4e8ec3fc4ba7ada10ef1a3c33fdedc70822df173))


### Bug Fixes

* create release PR via GitHub App token so required checks run ([#54](https://github.com/Einlanzerous/switchyard/issues/54)) ([912c939](https://github.com/Einlanzerous/switchyard/commit/912c93984713d7c0a59bdcd0868200e99f78f412))
* install anthropic in graphify CI so semantic extraction works ([#53](https://github.com/Einlanzerous/switchyard/issues/53)) ([046b6ba](https://github.com/Einlanzerous/switchyard/commit/046b6ba60c05fc95f56bbb7a9ea043b1ea34d81a))

## [2.23.1](https://github.com/Einlanzerous/switchyard/compare/v2.23.0...v2.23.1) (2026-05-22)


### Bug Fixes

* protect main branch ([#48](https://github.com/Einlanzerous/switchyard/issues/48)) ([c406929](https://github.com/Einlanzerous/switchyard/commit/c40692920087c0141a6cb8e4b43603e2276921c5))
* SWY-69 — auto-close rule fires on PR merge (new external-ref-poller actor) ([#47](https://github.com/Einlanzerous/switchyard/issues/47)) ([aca0617](https://github.com/Einlanzerous/switchyard/commit/aca0617f67d5e0af40e9aef88a7d46cfb991dae7))

## [2.23.0](https://github.com/Einlanzerous/switchyard/compare/v2.22.0...v2.23.0) (2026-05-21)


### Features

* SWY-66 — projects UI polish, color picker, contrast guard ([a3fbf71](https://github.com/Einlanzerous/switchyard/commit/a3fbf713c2a7d55868f84b351ec83501b9a72fa4))
* SWY-66 — projects UI polish, color picker, contrast guard ([a57bb4d](https://github.com/Einlanzerous/switchyard/commit/a57bb4dc856d70ffc5c5fdbd1305044e19038111))
* SWY-67 — ticket drawer + detail nits ([3fce925](https://github.com/Einlanzerous/switchyard/commit/3fce92573be54069fc64eebde8fd0b9f60fe2665))
* SWY-67 — ticket drawer + detail nits ([8a917c8](https://github.com/Einlanzerous/switchyard/commit/8a917c8ec09c830acd7b45adfe527bcf8894a397))


### Bug Fixes

* **SWY-66:** ColorPicker → popover trigger, wire missed SettingsProject ([42ec6e2](https://github.com/Einlanzerous/switchyard/commit/42ec6e2cab2ae8c2e8e45437127df5234641fd7e))
* **SWY-66:** ColorPicker trigger sizing + named swatch readout ([389396e](https://github.com/Einlanzerous/switchyard/commit/389396e843da24c35e5678415e325e4d8c271de5))
* **SWY-67:** rename Add chip → Link on links + external refs ([c33a39d](https://github.com/Einlanzerous/switchyard/commit/c33a39dbb04e1c985f43c36ad758eb3ab52a2c2b))

## [2.22.0](https://github.com/Einlanzerous/switchyard/compare/v2.21.0...v2.22.0) (2026-05-21)


### Features

* SWY-64 — MCP create_project + get_project + list_labels ([47496f4](https://github.com/Einlanzerous/switchyard/commit/47496f4058b57d18c12e5dcc8a00265b32298299))
* SWY-64 + SWY-65 — MCP create_project, DX polish, null clears ([35d0413](https://github.com/Einlanzerous/switchyard/commit/35d0413384d62429468db1cfc81ba0a1f3930b6f))
* SWY-65 — MCP DX polish (multi-status, by-category sugar, comments, null clears) ([b1a99e1](https://github.com/Einlanzerous/switchyard/commit/b1a99e13ec854a9b757912f145390cf07f65d67f))

## [2.21.0](https://github.com/Einlanzerous/switchyard/compare/v2.20.0...v2.21.0) (2026-05-21)


### Features

* **qr-login:** wrap QR as /login?token=... URL + drop Apple defaults ([81ee524](https://github.com/Einlanzerous/switchyard/commit/81ee524ddcb54e14f5d7bd8ec90135f16f2b4434))
* SWY-63 — QR-code device login + README restructure ([b93f675](https://github.com/Einlanzerous/switchyard/commit/b93f67558e0cc371f383ca3f7571a6124486a2c0))
* SWY-63 — QR-code device login + README restructure ([aa5f983](https://github.com/Einlanzerous/switchyard/commit/aa5f983a90d6acb73b6863d8359b93aa1315ee57))

## [2.20.0](https://github.com/Einlanzerous/switchyard/compare/v2.19.0...v2.20.0) (2026-05-19)


### Features

* SWY-48 5.1.0 — llm_observations schema + bulk endpoint ([b1d383d](https://github.com/Einlanzerous/switchyard/commit/b1d383d41ba3163c14991057425ec9d2586799ac))
* SWY-48 5.1.0 — llm_observations schema + bulk endpoint ([b9aeb88](https://github.com/Einlanzerous/switchyard/commit/b9aeb882d922fe03ae951f837dbf29cf1fecc474))

## [2.19.0](https://github.com/Einlanzerous/switchyard/compare/v2.18.1...v2.19.0) (2026-05-18)


### Features

* Phase 5.0 polish — error-path tests + live smoke (SWY-60, SWY-61) ([cce90cd](https://github.com/Einlanzerous/switchyard/commit/cce90cd417ca792ba95d27d1431c67e89cce3b00))
* SWY-60 — add mcp/scripts/smoke.ts live tool exerciser ([df6f705](https://github.com/Einlanzerous/switchyard/commit/df6f7052472722af4d56d96d2a8f111b3dab04ce))


### Bug Fixes

* **mcp/smoke:** print summary line on success too ([da11d69](https://github.com/Einlanzerous/switchyard/commit/da11d698124ee02fc331f65888f46b407623f614))

## [2.18.1](https://github.com/Einlanzerous/switchyard/compare/v2.18.0...v2.18.1) (2026-05-18)


### Bug Fixes

* **deploy:** include mcp workspace in Dockerfile bun install context ([7f910a1](https://github.com/Einlanzerous/switchyard/commit/7f910a16f3b71854e67994fe062af8ef026c474f))
* **deploy:** include mcp workspace in Dockerfile bun install context ([5aa776e](https://github.com/Einlanzerous/switchyard/commit/5aa776e85c9436e989ec80688dbc3298154b5f01))

## [2.18.0](https://github.com/Einlanzerous/switchyard/compare/v2.17.0...v2.18.0) (2026-05-18)


### Features

* SWY-36 — add get_project_statuses MCP tool ([98be7ad](https://github.com/Einlanzerous/switchyard/commit/98be7ad77548c56b5a030c34c78e0642c7ab4f41))
* SWY-36 — add query_my_open composed MCP tool ([ac92ae6](https://github.com/Einlanzerous/switchyard/commit/ac92ae6d4c4b817da252f7b9554817996e010734))
* SWY-36 — add v1 ticket MCP tool surface ([231939e](https://github.com/Einlanzerous/switchyard/commit/231939eb8c1d68a759f1788b5b2aec2a013d555a))
* SWY-36 Phase 5.0 — switchyard MCP server (v1 tool surface) ([b4bb79c](https://github.com/Einlanzerous/switchyard/commit/b4bb79c99dafe150d11c8eddf6c0461e43d5e0f6))
* SWY-36 Phase 5.0 — switchyard MCP server scaffold ([28608ba](https://github.com/Einlanzerous/switchyard/commit/28608bae7dff15928ff8baf3bec1791a9dfbebe6))

## [2.17.0](https://github.com/Einlanzerous/switchyard/compare/v2.16.0...v2.17.0) (2026-05-18)


### Features

* SWY-44 — Phase 4.8 sort tickets by due date (incl. cross-board) ([0f3482a](https://github.com/Einlanzerous/switchyard/commit/0f3482acb17bb4f7a8281cc6aa5df301cae7056f))
* SWY-44 — Phase 4.8 sort tickets by due date (incl. cross-board) ([ed78f85](https://github.com/Einlanzerous/switchyard/commit/ed78f854d1dbb5a2231d0829e5d33b0ce716ffd0))
* SWY-54 + 55 + 56 — Phase 4.12 deploy disruption reduction ([012fab7](https://github.com/Einlanzerous/switchyard/commit/012fab7a568df4008ab279b7ea98d15a5e775144))
* SWY-54 + 55 + 56 — Phase 4.12 deploy disruption reduction ([d1b8ef0](https://github.com/Einlanzerous/switchyard/commit/d1b8ef004b3fdccc8d840e6e9fbfd8ec4a804481))


### Bug Fixes

* focus the actual &lt;input&gt; on the login view ([851fb82](https://github.com/Einlanzerous/switchyard/commit/851fb82e042e5ec2a8a64c9a52907bf90ec0fab6))
* smart sort drops due-date primary so drag wins ([95aa400](https://github.com/Einlanzerous/switchyard/commit/95aa40068379acc182c114987dac1316a8019614))

## [2.16.0](https://github.com/Einlanzerous/switchyard/compare/v2.15.0...v2.16.0) (2026-05-15)


### Features

* SWY-57 + 58 + 59 — repo URL, detail-page delete, project Setup tab ([7521117](https://github.com/Einlanzerous/switchyard/commit/75211177dd058046152ec9169670aca52898ee71))
* SWY-57 + SWY-58 + SWY-59 — repo URL, detail-page delete, project Setup tab ([8003c63](https://github.com/Einlanzerous/switchyard/commit/8003c630cc796afcfa665347ee6ec8224598b343))

## [2.15.0](https://github.com/Einlanzerous/switchyard/compare/v2.14.0...v2.15.0) (2026-05-15)


### Features

* SWY-49 + SWY-50 — default "All projects" board + cross-project ticket move ([053c599](https://github.com/Einlanzerous/switchyard/commit/053c599a908971b52452602d5d47d5c6b253386b))
* SWY-49 + SWY-50 — default "All projects" board + move ticket cross-project ([68a9002](https://github.com/Einlanzerous/switchyard/commit/68a9002e51cbed3b7970e4d02aaf9bcdfff72e4d))

## [2.14.0](https://github.com/Einlanzerous/switchyard/compare/v2.13.0...v2.14.0) (2026-05-14)


### Features

* SWY-43 Phase 4.7 — recurring & one-shot ticket templates ([b65b7ad](https://github.com/Einlanzerous/switchyard/commit/b65b7ad34e14530fe5f073b00522fdf7f7ef4656))
* SWY-43 Phase 4.7 backend — ticket templates (recurring + one-shot) ([7ef49ea](https://github.com/Einlanzerous/switchyard/commit/7ef49ea284e82f34d1871bbaed56f1098cf7b765))
* SWY-43 Phase 4.7 UI — Recurring tab + template editor + drawer badge ([f1c18d4](https://github.com/Einlanzerous/switchyard/commit/f1c18d404e2797f76c07c124e96e42ed7d09b8f2))

## [2.13.0](https://github.com/Einlanzerous/switchyard/compare/v2.12.0...v2.13.0) (2026-05-14)


### Features

* Phase 4 polish — state pills, Targets URL wrap, settings input fix, README ([3ccb251](https://github.com/Einlanzerous/switchyard/commit/3ccb25109aaa118ec6922070f3af423f662e5002))
* Phase 4 polish — state pills, Targets URL wrap, settings input fix, README ([43111c7](https://github.com/Einlanzerous/switchyard/commit/43111c7c42696d4c0acd2c69e7afb2a0f76b47e6))

## [2.12.0](https://github.com/Einlanzerous/switchyard/compare/v2.11.1...v2.12.0) (2026-05-13)


### Features

* SWY-42 Phase 4.6 — surface due_date in the UI + overdue/late stats ([3148a39](https://github.com/Einlanzerous/switchyard/commit/3148a399ce72c8c086d2b08b0040a23c708f3f3d))
* SWY-42 Phase 4.6 — surface due_date in the UI + overdue/late stats ([b674327](https://github.com/Einlanzerous/switchyard/commit/b67432731856660dbd19e2512a72a668be412635))

## [2.11.1](https://github.com/Einlanzerous/switchyard/compare/v2.11.0...v2.11.1) (2026-05-13)


### Bug Fixes

* Phase 4.4 polish — unified Board/Insights header, smaller switch, empty-board cleanup ([d8b8ff7](https://github.com/Einlanzerous/switchyard/commit/d8b8ff755e101a11ab5ef87ad6651bfb011525c0))

## [2.11.0](https://github.com/Einlanzerous/switchyard/compare/v2.10.0...v2.11.0) (2026-05-13)


### Features

* Phase 4.5.3 GitHub webhook receiver + auto-detect from PR convention ([4eab6e7](https://github.com/Einlanzerous/switchyard/commit/4eab6e70bbde50c458bb5421bf8c5ccf243b02ee))

## [2.10.0](https://github.com/Einlanzerous/switchyard/compare/v2.9.0...v2.10.0) (2026-05-13)


### Features

* viewport-locked sidebar + Closed-column window (global + per-project) ([a8fbbac](https://github.com/Einlanzerous/switchyard/commit/a8fbbac61d192ed3e43d753383e9aaac866fe321))

## [2.9.0](https://github.com/Einlanzerous/switchyard/compare/v2.8.0...v2.9.0) (2026-05-13)


### Features

* Phase 4.5 closeout plan + ready-for-agent label + labels route fix ([15b6996](https://github.com/Einlanzerous/switchyard/commit/15b699651050eb25049dda5c082356cc819423f6))
* Phase 4.5.0 ticket links — blocks / relates_to / duplicates ([f351daf](https://github.com/Einlanzerous/switchyard/commit/f351daf1ef45ee35c64f32f7212b5f6d5d21a03a))
* Phase 4.5.1 custom field schemas — typed views over metadata JSONB ([fd7161d](https://github.com/Einlanzerous/switchyard/commit/fd7161dba3de5bf7fdf682f4181c2cd0fb5d66ad))
* Phase 4.5.2 external refs (manual attach + polling) + board polish ([dd6694c](https://github.com/Einlanzerous/switchyard/commit/dd6694c238b9a948d01c8c6c72b86d699fa0d0a5))

## [2.8.0](https://github.com/Einlanzerous/switchyard/compare/v2.7.0...v2.8.0) (2026-05-12)


### Features

* Phase 4.3 UI — rules / firings / targets under Automations ([cebbf4e](https://github.com/Einlanzerous/switchyard/commit/cebbf4ee2ce3a11e5346a75e6dc41a85c13b798a))

## [2.7.0](https://github.com/Einlanzerous/switchyard/compare/v2.6.0...v2.7.0) (2026-05-12)


### Features

* Phase 4.2 native rules — scheduled triggers + ticket-query targeting ([3c12ff6](https://github.com/Einlanzerous/switchyard/commit/3c12ff69b4ec0ea060bc62985fae88fa1d02a46a))
* Phase 4.2.5 native rules — named webhook targets ([ef31034](https://github.com/Einlanzerous/switchyard/commit/ef31034c4329d0c640d2a394ca1be3e83a7abc11))

## [2.6.0](https://github.com/Einlanzerous/switchyard/compare/v2.5.0...v2.6.0) (2026-05-12)


### Features

* show release version in sidebar footer ([f3b138d](https://github.com/Einlanzerous/switchyard/commit/f3b138d8147865bb133a7399ce6ba70bad127314))

## [2.5.0](https://github.com/Einlanzerous/switchyard/compare/v2.4.0...v2.5.0) (2026-05-12)


### Features

* Phase 4.1 native rules — remaining actions + global rules + rate limit ([4752fd6](https://github.com/Einlanzerous/switchyard/commit/4752fd62acb6f21a7cb1110c790dfaddc01d5d5d))

## [2.4.0](https://github.com/Einlanzerous/switchyard/compare/v2.3.0...v2.4.0) (2026-05-11)


### Features

* Phase 4.0 native automation rules — engine foundations + 3 core actions ([9cf48f7](https://github.com/Einlanzerous/switchyard/commit/9cf48f7ef44bf76e4eb9aace20aec2716c7c3721))

## [2.3.0](https://github.com/Einlanzerous/switchyard/compare/v2.2.0...v2.3.0) (2026-05-11)


### Features

* Logo + theme recolor ([cef203a](https://github.com/Einlanzerous/switchyard/commit/cef203acff5f0dcf91e6c4b425d62bfcac0cf42f))

## [2.2.0](https://github.com/Einlanzerous/switchyard/compare/v2.1.0...v2.2.0) (2026-05-11)


### Features

* graphify support, and added workflow ([f3b0aeb](https://github.com/Einlanzerous/switchyard/commit/f3b0aebc881d83b55f2183938118144e71f25063))


### Bug Fixes

* logo cleanup ([9898260](https://github.com/Einlanzerous/switchyard/commit/9898260d0a18105413e0c7624938dc607779db25))

## [2.1.0](https://github.com/Einlanzerous/switchyard/compare/v2.0.0...v2.1.0) (2026-05-11)


### Features

* New logo ([78a771e](https://github.com/Einlanzerous/switchyard/commit/78a771e051fa05502dd687668f6dd8e3bbd664a4))

## [2.0.0](https://github.com/Einlanzerous/switchyard/compare/v1.2.1...v2.0.0) (2026-05-10)


### ⚠ BREAKING CHANGES

* publish containers

### Features

* publish containers ([4861d37](https://github.com/Einlanzerous/switchyard/commit/4861d3753e8563f1e4e5650bf4ca7b253ebdf4dd))

## [1.2.1](https://github.com/Einlanzerous/switchyard/compare/v1.2.0...v1.2.1) (2026-05-10)


### Bug Fixes

* test cleanup, viewport fix on many views ([3573b12](https://github.com/Einlanzerous/switchyard/commit/3573b12eff6754ba2264976a264521c64e992524))

## [1.2.0](https://github.com/Einlanzerous/switchyard/compare/v1.1.0...v1.2.0) (2026-05-10)


### Features

* Phase 3.3 wrap status: ([0dd9ca3](https://github.com/Einlanzerous/switchyard/commit/0dd9ca3ff0e9a18e0ad8d7079bf38d3efe9851c1))
* playwright tests ([c2a3894](https://github.com/Einlanzerous/switchyard/commit/c2a389424e49177f142172803188f3df96fdd45f))
* Project insights, user dashboard ([8c85565](https://github.com/Einlanzerous/switchyard/commit/8c85565af605c7e764ad67ed43282c9aaf467d16))
* Saved views, bulk operations ([b5731a7](https://github.com/Einlanzerous/switchyard/commit/b5731a7df67047f2fb878ec244bb2a94a42857dd))


### Bug Fixes

* Actual test fix, and add local test run bits to gitignore ([ddfa47b](https://github.com/Einlanzerous/switchyard/commit/ddfa47ba34c7c8202bee14a4372aaa14c2a47abe))
* additional runner fixes ([ea5c2ef](https://github.com/Einlanzerous/switchyard/commit/ea5c2ef971da5a39ed097f88ec89981ea87dc4c0))
* avatar default color fills the icon now ([f8cdf70](https://github.com/Einlanzerous/switchyard/commit/f8cdf70e11d6c8d03ad9414abc0f3faaee9cdbc2))
* e2e playwright install ([2f66200](https://github.com/Einlanzerous/switchyard/commit/2f6620086ff191c6286a74cdaefea32712db9418))
* ensure failed tests upload artifacts for debugging tests, fix some small issues with current tests ([97ae748](https://github.com/Einlanzerous/switchyard/commit/97ae74881670510ba7d10aa317c60d201690ec58))
* seed db issues during e2e ([751a94d](https://github.com/Einlanzerous/switchyard/commit/751a94dfc4d30c2c6b474f52fcc3e5d7aa301f12))
* tests found a real bug around user query race condition ([af22ed1](https://github.com/Einlanzerous/switchyard/commit/af22ed125a4566edeb10d38c648031edc9ee2093))
* Update test selector to be more reliable ([c20544c](https://github.com/Einlanzerous/switchyard/commit/c20544c545614754049f2cf38439b36f327e0dec))
* Update test selector to be more reliable ([72dcd6f](https://github.com/Einlanzerous/switchyard/commit/72dcd6f5494de1395fac006c2ce11bb705c08710))

## [1.1.0](https://github.com/Einlanzerous/switchyard/compare/v1.0.0...v1.1.0) (2026-05-09)


### Features

* General polish and cleanup, closing out phase 2 ([0404837](https://github.com/Einlanzerous/switchyard/commit/0404837f80507b2d86cc6543e51359bb7e673987))
* New stats endpoints, clean up project page ([f22796f](https://github.com/Einlanzerous/switchyard/commit/f22796fda215bd9bdaf17225f6e9f8cf280131ca))
* Proper support for labels globally, some small QoL changes to ticket control ([5562201](https://github.com/Einlanzerous/switchyard/commit/55622018e8354aa23f4d90bda210a3f8979c42db))

## 1.0.0 (2026-05-09)


### Features

* 2.3-2.5 implemented, boards, ticket details, swimlanes ([43791ca](https://github.com/Einlanzerous/switchyard/commit/43791cae78df602ae0c25cc91a386958ce5e6429))
* phase 2.0 ([53bbb3f](https://github.com/Einlanzerous/switchyard/commit/53bbb3fbed0e018a43590c389125555e09fc8147))
* phase 2.1 and 2.2, auth + tickets page ([9eafd9a](https://github.com/Einlanzerous/switchyard/commit/9eafd9a682ab076f1fe1e3d2e02c1935c369f669))
