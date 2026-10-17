# シナリオ

`config/scenarios/（名前）/` に、base の設定に重ねる差分だけを置きます。起動時に `SCENARIO=winter` のように選び、指定がなければ今までどおりの町（base）で動きます。base の `config/world.json` と `config/characters.json` は書き換えません。

| ファイル | 中身 |
| --- | --- |
| `scenario.json` | 名前・説明。`extends` に別のシナリオを書くと、それを土台にする |
| `world.json` | `config/world.json` に重ねる差分 |
| `characters.json` | `config/characters.json` に重ねる差分。`residents` は名前で突き合わせる |

重ね方：オブジェクトは項目ごとに重ね、配列と値は置き換えます。配列の位置に `{"$append": [...]}` と書くと、元の配列の後ろに足します。

| 名前 | 内容 |
| --- | --- |
| `winter` | 冬の町。空腹を「空腹度：9/10」のように数字で伝える（条件A） |
| `winter-words` | 冬の町。空腹を数字を使わずに言葉で伝える（条件B）。`winter` を土台にする |
| `aquarium` | 箱庭に気づく住人。行商人ロッテだけが「この町は箱庭かもしれない」と疑っている |
| `aquarium-v2` | 箱庭に気づく住人の2回目。ロッテの表向きの目的に「町の外のことを聞いて回る」、秘密に「この町は箱庭ではないかと疑い始めている」を足す。`aquarium` を土台にする |
