# Shade the region where f(x) ≥ x² − 3x + 2

Creative: `parabole` · language: `fr` · runtime: 35s
On-screen opener: **hachure la bonne région**
Signature line: **Le piège est là.** (fires once)

| Beat | Spoken | On screen |
| ---: | :--- | :--- |
| 0:00 | *(no line)* | `f(x) ≥ x² − 3x + 2` |
| 0:02 | f de x, c'est la hauteur : donc tous les points sur la courbe ou au-dessus. | `y ≥ x² − 3x + 2` |
| 0:06 | La frontière d'abord. Factorise pour trouver où elle coupe. | `(x − 1)(x − 2) = 0` |
| 0:10 | Un et deux. | figure: parabola_region · figure step: roots |
| 0:14 | Plus grand ou égal. La courbe fait partie de la région — trait plein, jamais pointillé. | figure step: solid |
| 0:19 | Maintenant, quel côté ? Le symbole ne te le dit pas. Teste un point. Prends l'origine. | figure step: test · `0 ≥ 0² − 3(0) + 2` |
| 0:24 | Zéro n'est pas plus grand que deux. Faux — l'origine est exclue, tu hachures l'autre côté. | `0 ≥ 2` (red: 0 ≥ 2) · strike `false` in red · figure step: shade |
| 0:29 | Le piège est là — « plus grand » ne veut pas dire vers le haut de la page. Un point test règle ça à tous les coups. | TRAP card — le symbole ne choisit pas le côté — le point test, oui |
| 0:33 | *(no line)* | *(hold)* |
