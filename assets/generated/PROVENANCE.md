# Generated ghost assets and Bellgrave UI references

Generated October 31, 2026 with the native built-in imagegen tool. The ghost atlas is a production raster asset for camera-facing planes; it is not a rigged 3D model. The UI board is a design concept, not an implemented gameplay screenshot.

## Deliverables

| Asset | Dimensions | SHA256 |
| --- | --- | --- |
| [Ghost atlas](ghosts/haunts-atlas.png) | 1254 × 1254, RGBA PNG | `41a11814cb4c9034d1f41c5217a6d45bfebe4bef8245fb472f497cd7eedac196` |
| [Bellgrave title background](ui/title-background.png) | 1672 × 941 | `6538ca97b4620db0224927b7390d51fad94aa0998ff8cf0e7b42e161bc28adcb` |
| [HUD, shrine and defeat concept board](../../docs/concept-art/ui/05-gameplay-shrine-defeat.png) | 1024 × 1536 | `05d255b5b5ad0fce428d225b178f7eeb916c50bb7827e345f0e3be0f86e268b8` |

Original references:
- [Ghost cast](../../docs/concept-art/02-ghost-cast-morrow-nix-vesper.png)
- [Morrow memory and return](../../docs/concept-art/03-morrow-memory-and-return.png)
- [Bellgrave cemetery](../../docs/concept-art/06-map-bellgrave-cemetery.png)
- [Main menu](../../docs/concept-art/ui/02-main-menu.png)

## Atlas layout

The atlas has four 627 × 627 cells. Pixel rectangles below use top-left image origin and exclusive right/bottom endpoints. Normalized rectangles are `left, top, right, bottom` in the same image coordinate convention.

| Character | Cell position | Pixel rectangle | Normalized image rectangle |
| --- | --- | --- | --- |
| Morrow | top left | 0, 0, 627, 627 | 0, 0, 0.5, 0.5 |
| Nix | top right | 627, 0, 1254, 627 | 0.5, 0, 1, 0.5 |
| Vesper | bottom left | 0, 627, 627, 1254 | 0, 0.5, 0.5, 1 |
| Raksha | bottom right | 627, 627, 1254, 1254 | 0.5, 0.5, 1, 1 |

For a conventional bottom-left-origin UV texture, Morrow is `(0,0.5)-(0.5,1)`, Nix `(0.5,0.5)-(1,1)`, Vesper `(0,0)-(0.5,0.5)`, Raksha `(0.5,0)-(1,0.5)`. The renderer must account for its texture upload `invertY` convention exactly once.

### Optional tighter crops

These rectangles include about eight pixels of padding around alpha ≥16 content. They improve plane sizing and retain each creature's original proportions. Map the crop to a plane with the listed width/height ratio; keep the creature upright and face the camera around the world Y axis. The upper and lower ghost rows have transparent separation.

| Character | Pixel rectangle (exclusive right/bottom) | Normalized image rectangle | Crop aspect |
| --- | --- | --- | --- |
| Morrow | 152, 88, 522, 596 | 0.121212, 0.070175, 0.416268, 0.475279 | 370 × 508 |
| Nix | 763, 150, 1152, 581 | 0.608453, 0.119617, 0.918660, 0.463317 | 389 × 431 |
| Vesper | 126, 696, 549, 1163 | 0.100478, 0.555024, 0.437799, 0.927432 | 423 × 467 |
| Raksha | 731, 695, 1182, 1159 | 0.582935, 0.554226, 0.942584, 0.924242 | 451 × 464 |

### Alpha and readability verification

The PNG has real transparency, not a painted checkerboard. All four image corners have alpha 0. The generator leaves faint residual alpha 1 pixels far outside some silhouettes; at alpha ≥16, each cell's content bounds are:
- Morrow: x160..513, y96..587.
- Nix: x771..1143, y158..572.
- Vesper: x134..540, y704..1154.
- Raksha: x739..1173, y703..1150.

Both center boundaries have no pixel at alpha ≥16, and the outside boundaries have none. Use an alpha discard/cutoff of at least `16/255` (about 0.063) to remove invisible dust, then normal alpha blending for spectral wisps. Preserve the PNG alpha. Avoid an opaque plane backing, additive blending, and strong whole-sprite bloom; the character image already includes restrained spectral light. Tight crop dimensions are a sizing aid, not a requirement to modify or re-encode the PNG. Alpha inspection receipts are ignored under `output/imagegen/`.

The title background contains no baked title, menu buttons or labels. Build actual screen text and controls as DOM UI. The board keeps one Bellgrave courtyard/chapel approach, three encounters then a boss, and one echo portal within the same map. It does not introduce another world or a deity selection screen.

## Exact native generation prompts

The first atlas pass preserved identities but crowded the cell boundaries. The selected final atlas is the targeted layout correction below. The raw first pass was not copied into the project assets.

### Ghost atlas initial pass
Tool: native imagegen; `transparent_background=true`.
References: ghost cast, Morrow memory/return.

```text
Use case: stylized-concept.
Asset type: production transparent PNG creature sprite atlas for camera-facing vertical planes in the 3D browser game ISSEKAIED.
Reference image 1 (ghost lineup) is the identity and sculpted painterly material reference for Morrow, Nix and Vesper. Reference image 2 is additional Morrow identity and memory stitch reference. Preserve the actual masks, costumes, silhouettes, bronze details and sea-glass spectral accents from those references, not generic replacement ghosts.
Make ONE square 2048 by 2048 RGBA image with TRUE TRANSPARENT BACKGROUND, containing EXACTLY FOUR isolated full-body creatures arranged in a mathematically even 2 by 2 grid of equal square cells. The transparent grid itself is invisible, no drawn grid. Each subject is wholly contained within its own cell with generous transparent gutters on all sides; every hand, key, wingtip, ribbon and spectral tail must remain inside its cell. Center each subject horizontally in its cell, all full-body silhouettes end near the same lower baseline within their cell, with at least 10 percent cell margin. No overlap, no cropping. Each has the same direct front three-quarter camera, near-orthographic perspective, looking toward camera.
TOP LEFT: MORROW, the Grudgekeeper: tall crooked narrow ghost wearing a ragged charcoal broken-bell-shaped hood, cracked weathered ivory porcelain face with tiny hollow dark eyes, extremely long thin pointed hands, tattered dark burial cloth, hanging small tarnished brass bells, faint sea-glass chest spirit core and a single glowing stitched crack across shoulder and mask. Include the characteristic warm little hanging brass lantern held low in one hand. The material detail and unsettling dignity should closely match reference, with clearly visible face.
TOP RIGHT: NIX, the Collector: small squat round mischievous spectral thief tucked over and wrapped around a battered brown wooden travelling trunk, little ivory cracked face, huge expressive amber eyes, tiny stolen crooked crown, curled hood, small hands over trunk edge, dangling brass stolen keys, tiny pale spirit feet, ragged ochre and charcoal cloth, one sea-glass stitched crack crossing the trunk. Match the lovable but haunted trunk creature from reference, no toy simplification.
BOTTOM LEFT: VESPER, the Whisperwing: a floating slender charcoal burial-cloth moth wraith, ivory long mothlike bone mask with two large dark eyes, two upward swept narrow horn/antenna shapes, broad symmetrical ragged folded-open moth wings with faded ochre moon patterns and hanging tassels, long thin sea-glass spectral ribbons, stitched crack on shoulder. Wings stay within cell; match reference identity, not a bird or cartoon bat.
BOTTOM RIGHT: RAKSHA: a new distinct sturdy hunched guardian spirit from the SAME ensemble, no cultural or religious deity imagery; squat broad shoulder silhouette, broken ivory porcelain mask with two small pale amber eyes, a layered battered tarnished-brass shutter-plate cuirass tied over frayed black burial cloth, two long clawed hands, heavy bell straps, ragged floating tapered lower body instead of human legs, one remembered-defeat sea-glass repair stitch across chest. Coherent original folk-horror creature; no red demon, no gore.
Style: premium sculpted stylized 3D with painterly realistic surface wear, not lowpoly block cartoons. Bone, charcoal, tarnished brass, worn brown/ochre fabric, subtle pale cyan spirit seams. Self-contained soft key light reveals all masks and forms in a dark game world. Restrained spectral light, no huge bloom halos. Creatures should look dimensional and solid, only selective transparent wisps. No background color, no floor, no cast shadow plane, no environment, no vignette, no border, no UI, no labels, no lettering, no watermark. Transparent empty space must truly have alpha zero; do not paint a checkerboard.
```

### Ghost atlas selected layout correction
Tool: native imagegen; `transparent_background=true`.
Edit target: the initial pass, generation file ID `exec-121fcdbc-8c6c-4742-a777-4642b7fce56f.png`.
Selected output generation file ID: `exec-87b6de11-1d5a-4fee-87e2-e75a7262dde2.png`.

```text
Use case: identity-preserve. Asset type: transparent four-creature 2 by 2 game atlas. Reference image 1 is the EDIT TARGET. Preserve all four creature identities, poses, painterly sculpted details, colors, costumes, masks and restrained spirit light exactly. Change ONLY the layout, reducing each creature and giving every cell substantial guaranteed empty transparent margins.
One square RGBA PNG, TRUE TRANSPARENT BACKGROUND, no text or labels. Exactly FOUR same full-body creatures: MORROW top-left, NIX top-right, VESPER bottom-left, RAKSHA bottom-right.
CRITICAL GRID GEOMETRY: imagine the square canvas divided at x=50% and y=50%. The top-left creature must lie wholly inside x=8%..42%, y=8%..42%. Top-right wholly inside x=58%..92%, y=8%..42%. Bottom-left wholly inside x=8%..42%, y=58%..92%. Bottom-right wholly inside x=58%..92%, y=58%..92%. Scale each complete silhouette down uniformly until it fits those bounds, including every spectral ribbon, horn, hand, dangling key, lantern and wing. Thus a completely EMPTY TRANSPARENT CROSS from x=42% to58% and y=42% to58% separates all four creatures, and there is an 8% transparent border around all outside edges. Do not zoom into any creature. It is essential the entire creatures fit the interior 34%-square bounding boxes. No cut-off ends, no overlap, no floor, no backdrop, no shadow plane, no painted checkerboard, no border, no decorative frames. Retain clean fine cutout edges and real alpha-zero outside subjects. The output is a technical sprite atlas, not a tightly composed art poster.
```

### Clean Bellgrave title background
Tool: native imagegen; `transparent_background=false`.
References: Bellgrave cemetery map and main-menu concept.
Selected output generation file ID: `exec-ed064556-13e3-4b04-b1fd-2eb7ed83a7cf.png`.

```text
Use case: stylized-concept.
Asset type: clean 16:9 fullscreen title-screen background for ISSEKAIED, delivered as a single high-quality landscape image, ideally 2048 by 1152.
Reference image 1 is the Bellgrave cemetery map, which establishes architecture, materials and atmosphere. Reference image 2 is the existing main-menu visual direction: preserve the mood, restrained orange practical lights, deep charcoal-blue night, and RIGHT-HAND ruined bell-tower composition, but REMOVE ALL text, title lettering, buttons, rectangular panels, decorative frames, cursor and interface marks. Make an original clean scene plate that can accept real HTML UI later.
Eye-level cinematic view from the cobbled entrance to BELLGRAVE CEMETERY at night. A spectacular crooked ruined Gothic bell tower on the right third rises against a cloudy moon; its hanging bronze bell is distinct. Below it a weathered ivy-clad stone chapel arch and few warm brass lanterns. Wet uneven slate cobblestones lead from lower center into the cemetery; low gravestones, wrought-iron gate fragments, distant bare trees, gently layered low blue mist and a restrained few amber candles. Tangible painterly weathered stone and timber, original storybook folk horror. Cohesive with the concept art, not flat clip art and not a cartoon miniature. Keep architecture and pathways readable in the dark, restrained bloom, rich nuanced shadows. No players, no hands, no weapons, no close ghosts.
Composition: reserve the LEFT 42 percent as dark soft atmospheric negative space for later title/menu copy, with subtle fog, stone and tree silhouettes but no bright lamps or busy focal objects there. Keep the main dramatic architecture and moon in the right half. This is an environment image ONLY, no text or signs or typography anywhere, absolutely no buttons or menus or logos or watermark.
```

### Gameplay, shrine and defeat concept board
Tool: native imagegen; `transparent_background=false`.
References: main-menu concept, clean title background, ghost cast.
Selected output generation file ID: `exec-a200dcaa-8d0b-4e91-8a16-9bb42b39947a.png`.

```text
Use case: ui-mockup. Asset type: one visual design concept board for ISSEKAIED, a first-person haunted cemetery browser game, portrait composition with THREE clearly separated widescreen 16:9 screen concepts stacked vertically. Reference 1 is exact visual mood and UI material direction, reference 2 is clean Bellgrave setting, reference 3 is ghost identity. This is an honestly conceptual UI design board, not an implemented gameplay screenshot.
Cohesive art: midnight-blue painterly sculpted ruined cemetery, tarnished brass, bone parchment typography, ochre-gold outlines, warm amber candles, restrained tiny carved Halloween pumpkins near the shrine only, fog and old bells. Premium readable restrained folk horror, no grinning cartoon ghosts, no flat neon dashboard, no bright white rectangles or floating glowing labels, no extreme bloom, no character-selection or deity-selection screen. Simple elegant HTML-implementable interface, information hierarchy, readable contrast, quiet UI with fine gold dividers and translucent charcoal panels. A single Bellgrave courtyard and chapel approach only; one echo portal sits inside that same cemetery, not a second world. No overt map branching or huge quest log.
TOP SCREEN: FIRST-PERSON GAMEPLAY HUD. Show wet stone combat ring with central dry fountain, one Morrow in mid-distance with clear porcelain face and bell hood, ruined bell tower on right, lantern and tuning-fork banisher just at lower corners, calm sky and blue fog. Top-left slim red health bar and small label VITALITY. Top-right small concise objective card: BELLGRAVE / Silence the bells / Encounters 1 / 3. Small understated crosshair at center. Bottom-center compact five-slot brass-edged hotbar with exact text LMB Attack, RMB Ward, Q Incantation, R Heal, E Interact; simple meaningful pictograms, no huge labels over the enemy.
MIDDLE SCREEN: SHRINE / OBJECTIVE PANEL. Same game courtyard visible behind a calm near-right charcoal parchment panel titled THE BELL SHRINE. Body text only: Three encounters wake the keeper. Below three small bell seals, one lit, two dim; then BOSS SEALED. One subdued amber button RETURN TO HUNT and tiny E to commune prompt. To left show an old shrine with candle stubs and two restrained small pumpkins; a thin sea-glass echo ring visible through the same-map chapel arch, no new landscape inside.
BOTTOM SCREEN: DEFEAT AND RETRY. Same ruined Bellgrave background now softly defocused, Morrow recognizable distant silhouette. Center dark quiet translucent panel, restrained aged-gold title THE HAUNT REMEMBERS. Smaller line: Morrow remembers your last encounter. Two real readable buttons: RETURN TO BELLGRAVE (primary, amber outline), MAIN MENU (secondary dark). Small supporting text: Your next hunt begins here. No giant ghost face jumpscare, no white flash, no gore. Maintain the same visual family as reference main menu and avoid baked photorealistic laptop frames or devices.
Do not add any other panels or developer annotations. No watermarks. Interface labels should be crisp and readable.
```
