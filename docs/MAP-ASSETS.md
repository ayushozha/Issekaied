# Issekaied map assets and provenance

Prepared October 31, 2026.

## Playable level: Bellgrave

The game uses one hand-built Bellgrave map: the safe gate, pumpkin graveyard, ruined cathedral and eastern altar, joined by walkable routes. The current renderer builds the cathedral from stone geometry with crimson windows, rose tracery and warm candles. It uses modular graveyard props and illustrated enemy billboards. The downloaded 38 MB haunted-house model is retained with its attribution but is no longer loaded as the central building.

Generated artwork sets the visual direction; it is not a screenshot of the playable 3D scene. The tiled stone, cobble and aged-wood base-color images have [their own prompts and provenance](../assets/generated/materials/PROVENANCE.md). The named Raksha boss uses a [dedicated transparent sprite](../assets/generated/ghosts/raksha-boss.PROVENANCE.md); ordinary enemies keep their existing family artwork.

## Generated map concepts

Created with built-in image generation; exact prompts are in [MAP-PROMPTS.md](./concept-art/MAP-PROMPTS.md).

- [Bellgrave Cemetery](./concept-art/06-map-bellgrave-cemetery.png): graveyard, ruined bell tower, central fountain, crypt loop and flanking chapel route.
- [Whisperwood Shrine](./concept-art/07-map-whisperwood-shrine.png): haunted forest, giant hollow bell tree, abandoned shrine, bridge and alternate trail.
- [The Sunken Archive](./concept-art/08-map-sunken-archive.png): flooded abbey library, fallen clock, raised walkways and haunted mirror.

## Downloaded assembled scenes

| Scene | Local file | Download bytes | License | Current suitability |
| --- | --- | ---: | --- | --- |
| Haunted house | [haunted_house.glb](../assets/environments/babylon/haunted_house.glb) | 38,976,908 | CC-BY-4.0 under inspected upstream asset policy | Retained reference asset; replaced by the authored cathedral in gameplay |
| Valley village | [valleyvillage.glb](../assets/environments/babylon/valleyvillage.glb) | 9,492,256 | CC-BY-4.0 under inspected upstream asset policy | Terrain and positioned houses; default camera frames the large terrain, so focus on the village for gameplay |

Source: [Babylon.js Assets](https://github.com/BabylonJS/Assets), pinned revision `ffbd501c388cbf3ba29936851ef4b36bada145dc`. Upstream files are unmodified. No applicable model-specific license override was found in the inspected records. Original individual artists were not identified; preserve the [attribution record](../assets/environments/babylon/ATTRIBUTION.md), upstream policy and license.

[Exact URLs, hashes and structural checks](../assets/environments/babylon/SOURCE.json) are recorded locally. Both downloaded GLBs have embedded buffers/images and no external resource URIs; neither requires Draco or meshopt. Haunted House uses `KHR_materials_pbrSpecularGlossiness`.

### Verified interactive upstream previews

Both public scene previews rendered using Babylon Sandbox with WebGL2. These establish renderability of the upstream preview scenes, not first-person gameplay, collision, interior accessibility or performance of the completed game.

- [Rotate the haunted-house model](https://sandbox.babylonjs.com/?assetUrl=https://assets.babylonjs.com/meshes/haunted_house.glb)
- [Rotate the village environment](https://sandbox.babylonjs.com/?assetUrl=https://assets.babylonjs.com/meshes/valleyvillage.glb)
- [Captured haunted-house preview](./map-previews/haunted-house-sandbox.png)
- [Captured village preview](./map-previews/valley-village-sandbox.png)

The literal `https://...` asset URL works as the Sandbox query value; percent-encoding that entire value caused a load error during inspection.

## Downloaded modular kits

These are building blocks, not completed walkable maps.

| Kit | Local directory | Actual inspected browser formats | Asset license |
| --- | --- | --- | --- |
| Kenney Graveyard Kit 5.0 | [kenney-graveyard](../assets/environment-kits/kenney-graveyard/) | 91 GLB models; 7 models contain animation clips | CC0-1.0 |
| KayKit Halloween Bits, pinned free GitHub subset | [kaykit-halloween](../assets/environment-kits/kaykit-halloween/) | 63 glTF files with matching BIN files | CC0-1.0 |

- [Kenney creator page](https://kenney.nl/assets/graveyard-kit). Actual archive includes crypts, fences, gravestones, trees, lamps and a ghost character. [Creator sample image](../assets/environment-kits/kenney-graveyard/Sample.png).
- [KayKit official GitHub](https://github.com/KayKit-Game-Assets/KayKit-Halloween-Bits-1.0), pinned commit `6dc69bf6b2fa766a985754f35ec6a0324090e6c6`. The archive contains glTF and OBJ exports; FBX is not in this downloaded GitHub subset.
- Both original ZIPs and included asset licenses were preserved locally. Original ZIPs and duplicate FBX/OBJ exports are excluded from Git; browser-ready GLB/glTF resources and licenses are versioned. [Download records, counts and validation](../assets/environment-kits/SOURCE.json).
- Keep Kenney's `Models/GLB format/Textures/colormap.png` alongside the models using that relative path.
- Keep KayKit glTFs with their matching BIN files and `halloweenbits_texture.png`.

## Additional option, not downloaded

[Quaternius Medieval Village MegaKit](https://quaternius.com/packs/medievalvillagemegakit.html) is the closest modular architectural direction to the original village reference. The creator lists CC0, glTF/OBJ/FBX, and a free Standard subset. The entire 300+ catalog and prepared engine projects span paid tiers, so do not treat every advertised feature as part of the free download.

## Original asset-sourcing verification

- Three map PNGs saved and decoded successfully.
- Two assembled GLBs validated structurally, with pinned source and hashes.
- Both upstream assembled scenes rendered in a browser viewer.
- All 91 Kenney GLB headers and all 63 KayKit glTF JSON files checked; 217 referenced local resources were found.
- Archives checked for unsafe/duplicate extraction paths; original archives and license files retained.
- These checks describe the original asset-sourcing task. Current gameplay and provider verification are recorded separately in [DEMO.md](DEMO.md).
