// ブラウザに渡す、設定のうち表に出してよい部分

export function publicWorld(w) {
  return {
    town_name: w.town_name,
    places: w.places,
    map: w.map,
    time: w.time,
    meeting: w.meeting,
    bakery: { place: w.bakery.place, owner: w.bakery.owner },
    heaven: { storm_closed_places: w.heaven.storm_closed_places, free_text_max: w.heaven.free_text_max },
  };
}

export function publicCharacters(c) {
  // 画面に出すのは表向きの情報と、内心表示用の秘密（人間は全部見てよい）
  return c.residents.map((r) => ({
    name: r.name,
    short: r.short,
    initial: r.initial,
    color: r.color,
    age_job: r.age_job,
    public_goal: r.public_goal,
    secret: r.secret,
    meeting_initial: r.meeting_initial,
    home: r.home,
    work_places: r.work_places,
  }));
}
