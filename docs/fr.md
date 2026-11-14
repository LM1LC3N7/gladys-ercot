# Prix temps réel ERCOT (Texas)

Intégration non officielle, sans lien avec ERCOT. Elle lit les **prix temps réel** (Settlement Point
Prices, rapport NP6-905-CD) des zones de charge texanes choisies, par
l'[API publique officielle d'ERCOT](https://developer.ercot.com/applications/pubapi/user-guide/registration-and-authentication/),
toutes les 15 minutes, et en alimente les contrats d'énergie de Gladys.

Jamais testée avec un vrai compte ERCOT : les requêtes suivent la documentation officielle et sa
description OpenAPI, les réponses n'ont été vérifiées que sur des réponses synthétiques.

## Mise en place

1. Créez un compte gratuit sur l'[ERCOT API Explorer](https://apiexplorer.ercot.com/) (Sign In / Sign Up,
   vérification de l'e-mail, mot de passe de votre choix).
2. Dans **Products**, abonnez-vous au produit **Public API** ; dans votre **Profile**, affichez et copiez
   la **Primary key** de l'abonnement.
3. Dans Gladys, remplissez la configuration : l'e-mail du compte, son mot de passe, la clé d'abonnement et
   les zones de charge à lire (celle de votre logement : votre fournisseur ou distributeur la connaît).
4. Créez les appareils voulus depuis l'onglet Découverte, et un contrat d'énergie à partir du modèle
   « Prix temps réel ERCOT » de votre zone.

ERCOT bloque les requêtes venant de hors des États-Unis : l'intégration ne fonctionne que depuis un Gladys
installé aux États-Unis.

Le mot de passe ne sert qu'à une chose : le jeton d'identité d'une heure, demandé comme la documentation
d'ERCOT le montre (un POST vers `ercotb2c.b2clogin.com`, identifiant et mot de passe dans le corps du
formulaire, jamais dans l'adresse). Le mot de passe et la clé d'abonnement sont gardés par Gladys dans sa
base ; l'intégration garde le jeton en mémoire seulement et n'écrit jamais le mot de passe, la clé ni le
jeton, ni ne les journalise.

## Ce que vous obtenez

- **Un calendrier d'énergie Gladys par zone** : `spot-ercot-rt-lz-houston`, `-north`, `-south`, `-west`, un
  prix par intervalle de 15 minutes en USD par kWh (le prix ERCOT en $/MWh divisé par 1 000), heure locale
  du Texas (America/Chicago). La première lecture remonte trois jours ; après une panne, la lecture
  reprend au dernier prix connu (trois jours au plus).
- **Un modèle de contrat par zone**, « Prix temps réel ERCOT, zone de charge <zone> » : le prix temps réel
  plus votre supplément par kWh (marge du fournisseur, frais d'acheminement au kWh), vos redevances
  mensuelles et un taux de taxe, tous à 0 par défaut, et un **prix de repli que vous choisissez** (sans
  valeur par défaut).
- **Un appareil par zone** avec un capteur, « Real-time price ($/MWh) » : le prix du dernier intervalle
  publié par ERCOT, envoyé une fois. Sans date tant que cet intervalle s'est terminé il y a moins de
  30 minutes (une scène peut y réagir), daté de sa fin jusqu'à 2 heures, plus envoyé au-delà.

## Ce que le moteur de Gladys ne sait pas exprimer

- **L'intervalle en cours n'a pas encore de prix.** ERCOT publie un prix temps réel quelques minutes après
  la fin de son intervalle de 15 minutes. Le widget de prix et la condition de scène « prix actuel »
  montrent donc le **prix de repli** du contrat pour l'intervalle en cours, et le coût d'un intervalle lu
  avant l'arrivée de son prix est calculé au prix de repli, puis corrigé quand le prix arrive (Gladys
  recalcule les coûts qui lisaient une valeur de calendrier changée). Gladys le signale sur sa page des
  tâches à chaque usage du prix de repli.
- **Un prix manquant n'est jamais deviné** : un intervalle qu'ERCOT donne sans nombre lisible (vide,
  texte) est laissé hors du calendrier ; il ne vaut jamais 0.
- Le modèle est la forme simple d'une offre indexée sur le prix de gros (prix + supplément + redevances
  mensuelles + taxe) ; ni frais de puissance, ni tranches, ni prix plafonné.
- Les prix de gros ne sont pas votre tarif : la plupart des offres texanes sont à prix fixe.

## Lectures, rythme et erreurs

- Un cycle toutes les 15 minutes, jamais plus tôt (ERCOT publie un prix par quart d'heure ; seules
  exceptions, après un refus : de nouveaux identifiants, le bouton, une fois par minute au plus) : un jeton si
  besoin (réutilisé 55 minutes), puis une requête par zone, une à la fois. Au plus 6 requêtes par cycle,
  bien sous les 30 requêtes par minute permises par ERCOT. L'heure de chaque cycle est écrite dans `/data`
  avant sa première requête : un redémarrage ou une nouvelle configuration garde le rythme.
- Les erreurs (pas de réponse, HTTP 5xx, 403) mettent les lectures en pause 15 minutes, puis 30, 60…
  jusqu'à 6 heures. Un HTTP 429 les met en pause de la même façon, plus longtemps si son `Retry-After` le
  demande (6 heures au plus). Une pause survit aux redémarrages et vaut aussi pour le bouton.
- Un HTTP 403 signifie en général que la requête venait de hors des États-Unis : c'est un échec, pas un
  refus.
- Un HTTP 401 qui ne nomme pas la clé d'abonnement : le jeton est renouvelé une fois et la zone relue ; si
  un nouveau jeton n'est pas accepté non plus, c'est un échec, réessayé après 15 minutes, puis au plus
  toutes les heures.
- **Refus** : une réponse OAuth `invalid_grant` à la demande de jeton (identifiant ou mot de passe refusé),
  ou un 401 qui nomme la clé d'abonnement, arrête les lectures. L'intégration ne réessaie pas d'elle-même
  les mêmes identifiants, même après un redémarrage (elle en garde 8 bits d'une empreinte salée dans
  `/data` : de quoi ne rien retrouver). De nouveaux identifiants sont essayés dans la minute. Le bouton
  **Tester la connexion** réessaie le compte (une fois par minute au plus) et lève le refus si ERCOT
  accepte.
- Une réponse illisible pour une zone n'arrête pas les autres zones.
- `/data` illisible ou non inscriptible : rien n'est lu tant que ce n'est pas réglé (nouvel essai toutes
  les 10 secondes).

## Hors périmètre

- Prix du lendemain (day-ahead), prix des hubs, prix de zone pondérés par l'énergie (LZEW), autres zones
  de charge (Austin Energy, CPS Energy, LCRA, Rayburn) : pas dans cette version.
- Demande et production du réseau ERCOT : voir l'intégration gladys-us-grid.
- Aucune commande : lecture seule.

## Données

Les prix viennent des informations de marché publiques d'ERCOT, lues par son API publique avec votre
propre compte et soumises aux [conditions d'utilisation](https://www.ercot.com/help/terms/data-portal) d'ERCOT. Rien
n'est livré avec l'intégration.
