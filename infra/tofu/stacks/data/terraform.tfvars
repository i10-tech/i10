# ⚠ COMMITTED ON PURPOSE — see infra/tofu/.gitignore.
#
# A Cloudflare account id and zone id: public identifiers that authenticate
# nothing. And this file IS the recovery path — S1 creates nothing and imports
# only what is listed here, so losing the state means re-running init, not
# reconstructing ownership by hand.
cloudflare_account_id = "0ccd9b8cd89606709f1c867a1f64d840"
cloudflare_zone_id    = "1b1638f11a5a0f893aef4fdca30c048e"
r2_location           = "eeur"
