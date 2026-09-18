Attempted the Studio Next (61997) deployment. It is blocked by GenVM on that network, not by our code.

Worked through: 61997 is absent from genlayer-js 1.1.8 (defined it), FeesDistributionMissing (moved to 2.0.0-rc.1), FeeValueMustBeNonZero (supplied estimated fees). The tx then reaches consensus MAJORITY_AGREE and GenVM fails: "invalid_contract runner malformed".

A three-line contract fails identically, so it is not our contract:
- pinned 1jb45aa8...z09h6 -> invalid_contract runner malformed
- :test and :latest -> exit_code 1
- control, same contract/SDK/hash on 61999 -> deploys fine

Evidence tx 0x4e97e842. Could you share the runner header Studio Next accepts? Everything else is wired: GENLAYER_NETWORK=studioNext selects 61997 end to end and /health reports the live network, chain id and adjudicator. We will deploy the same day.

Demo video: PASTE_LINK_HERE

Arc/BOT rails unchanged. Full evidence in genlayer/deployments.json.
