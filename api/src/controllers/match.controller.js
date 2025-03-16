const format = async (matches) => {
  const token = AUTH && matches.length ? jwt.sign({ route: 'storage' }) : null;
  matches = await Promise.all(
    matches.map(async (obj) => {
      const { id, filename, event, response, isTrained } = obj;

      // Ensure event is properly parsed and is a string
      let parsedEvent;
      if (typeof event === 'string') {
        parsedEvent = JSON.parse(event);
      } else {
        parsedEvent = event;
      }

      const { camera, type, zones, updatedAt } = parsedEvent;
      const key = `matches/${filename}`;
      const { width, height } = await sizeOf(
        fs.createReadStream(`${STORAGE.MEDIA.PATH}/${key}`)
      ).catch((/* error */) => ({ width: 0, height: 0 }));

      return {
        id,
        camera,
        type,
        zones,
        file: {
          key,
          filename,
          width,
          height,
        },
        isTrained: !!isTrained,
        response: typeof response === 'string' ? JSON.parse(response) : response,
        createdAt: obj.createdAt,
        updatedAt: updatedAt || null,
        token,
      };
    })
  );
  return matches;
};

module.exports.post = async (req, res) => {
  const limit = UI.PAGINATION.LIMIT;
  const { sinceId } = req.body;
  const { page } = req.query;
  const { filters } = req.body;
  const tmptable = crypto.createHash('md5').digest('hex').toString();

  const db = database.connect();

  if (!filters || !Object.keys(filters).length) {
    const [total] = db.prepare(`SELECT COUNT(*) count FROM match`).all();
    const matches = db
      .prepare(
        `SELECT * FROM match
          LEFT JOIN (SELECT filename as isTrained FROM train GROUP BY filename) train ON train.isTrained = match.filename
          ORDER BY createdAt DESC
          LIMIT ?,?`
      )
      .bind(limit * (page - 1), limit)
      .all();

    return res.send({ total: total.count, limit, matches: await format(matches) });
  }

  const confidenceQuery =
    filters.confidence === 0 ? `OR json_extract(value, '$.confidence') IS NULL` : '';

  db.prepare(
    `CREATE TEMPORARY TABLE IF NOT EXISTS ${tmptable} AS SELECT t.id, t.createdAt, t.filename, t.event, response, detector, value FROM (
    SELECT match.id, match.createdAt, match.filename, event, json_extract(value, '$.detector') detector, json_extract(value, '$.results') results, match.response
    FROM match, json_each( match.response)
    ) t, json_each(t.results)
  WHERE json_extract(value, '$.name') IN (${database.params(filters.names)})
  AND json_extract(value, '$.match') IN (${database.params(filters.matches)})
  AND json_extract(t.event, '$.camera') IN (${database.params(filters.cameras)})
  AND json_extract(t.event, '$.type') IN (${database.params(filters.types)})
  AND (json_extract(value, '$.confidence') >= ? ${confidenceQuery})
  AND json_extract(value, '$.box.width') >= ?
  AND json_extract(value, '$.box.height') >= ?
  AND detector IN (${database.params(filters.detectors)})
        GROUP BY t.id`
  ).run(
    filters.names,
    filters.matches.map((obj) => (obj === 'match' ? 1 : 0)),
    filters.cameras,
    filters.types,
    filters.confidence,
    filters.width,
    filters.height,
    filters.detectors
  );

  db.prepare(`SELECT * FROM ${tmptable}`)
    .all()
    .map((obj) => obj.id);

  const [total] = db
    .prepare(
      `SELECT COUNT(*) count FROM ${tmptable}
      WHERE id > ?
      ORDER BY createdAt DESC`
    )
    .bind(sinceId || 0)
    .all();

  const matches = db
    .prepare(
      `SELECT * FROM ${tmptable}
    LEFT JOIN (SELECT filename as isTrained FROM train GROUP BY filename) train ON train.isTrained = ${tmptable}.filename
        WHERE id > ?
        ORDER BY createdAt DESC
        LIMIT ?,?`
    )
    .bind(sinceId || 0, limit * (page - 1), limit)
    .all();

  db.exec(`DROP TABLE ${tmptable}`);

  res.send({ total: total.count, limit, matches: await format(matches) });
};

module.exports.reprocess = async (req, res) => {
  const { matchId } = req.params;
  if (!DETECTORS.length) return res.status(BAD_REQUEST).error('no detectors configured');

  const db = database.connect();
  let [match] = db.prepare('SELECT * FROM match WHERE id = ?').bind(matchId).all();

  if (!match) return res.status(BAD_REQUEST).error('No match found');

  const results = await process.start({
    camera: tryParseJSON(match.event) ? tryParseJSON(match.event).camera : null,
    filename: match.filename,
    tmp: `${STORAGE.MEDIA.PATH}/matches/${match.filename}`,
  });

  database.update.match({
    id: match.id,
    event: JSON.parse(match.event),
    response: results,
  });

  match = db
    .prepare(
      `SELECT * FROM match
      LEFT JOIN (SELECT filename as isTrained FROM train GROUP BY filename) train ON train.isTrained = match.filename
      WHERE id = ?`
    )
    .bind(matchId)
    .all();
  [match] = await format(match);

  res.send(match);
};
