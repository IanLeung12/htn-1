# Spawnable asset catalog - sources and licenses

All assets below are from the Khronos Group's [glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)
repository (`Models/<Name>/glTF-Binary/<Name>.glb`), downloaded on 2026-09-19. Only
CC0/CC-BY/Apache/MIT-licensed models under 3 MB were kept; several candidates (Lantern,
Avocado, BoomBox, WaterBottle, SheenChair, GlamVelvetSofa) were skipped for exceeding the
3 MB budget, and Duck was skipped because its README lists a non-permissive "SCEA Shared
Source License".

| File | Catalog id | Source | Author(s) | License | Size |
|---|---|---|---|---|---|
| `ChairDamaskPurplegold.glb` | `chair` | [Model dir](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/ChairDamaskPurplegold) | Eric Chadwick for Wayfair (2021) | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode) | ~1.98 MB |
| `GlassVaseFlowers.glb` | `vase` | [Model dir](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/GlassVaseFlowers) | Eric Chadwick (vase); Rico Cilliers (flowers) (2023) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/legalcode) | ~1.74 MB |
| `GlassHurricaneCandleHolder.glb` | `lamp` | [Model dir](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/GlassHurricaneCandleHolder) | Eric Chadwick for Wayfair, LLC (2021) | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode) | ~2.58 MB |
| `ClearcoatWicker.glb` | `basket` | [Model dir](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/ClearcoatWicker) | Eric Chadwick (2023) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/legalcode) | ~1.24 MB |
| `SunglassesKhronos.glb` | `sunglasses` | [Model dir](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/SunglassesKhronos) | Eric Chadwick for Darmstadt Graphics Group GmbH (2024); Khronos/3D Commerce logos are non-copyrightable trademarks | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode) | ~0.35 MB |
| `Fox.glb` | `fox` | [Model dir](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Fox) | PixelMannen (model, 2014); tomkranis (rigging/animation, 2014); @AsoboStudio & @scurest (glTF conversion, 2017) | Model: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/legalcode); rig/animation/conversion: [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode) | ~0.16 MB |

## Notes on catalog framing

The Khronos Sample Assets are PBR-extension test/showcase models, not a general room-object
library, so a few are labeled loosely for this catalog: `ClearcoatWicker` (a sphere
demonstrating a wicker `KHR_materials_clearcoat` material) is presented as a small woven
basket/decor object, and `Fox`/`SunglassesKhronos` are presented as small tabletop decor
rather than literal "book stack"/"speaker" items, since no permissively-licensed model under
3 MB for those exact objects was found in the repository at the time of writing. Geometry
and materials are unmodified from the upstream `.glb`.
