// build.js — Runs in GitHub Actions to fetch Airtable data and produce standings JSON
const fs = require('fs');
const path = require('path');

const CONFIG = {
    AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
    BASE_ID: 'app4txUhczLPqX4y9',
    TABLES: {
        PLAYERS: 'tblPKYkozpIBzLZu3',
        MATCHES: 'tblGFMJLUSgN6qWq0',
        DOUBLES_TEAMS: 'tblJlCPXQwzJWKh5q',
        DOUBLES_MATCHES: 'tblOvYnQ1Bo5Up348',
        MATCH_TYPES: 'tblmc9u4HZT56ycMX',
    },
    EXPIRY_MONTHS: 6,
    LOSER_POINT_FRACTION: 0.10,
};

async function airtableFetch(tableId) {
    const baseUrl = `https://api.airtable.com/v0/${CONFIG.BASE_ID}/${tableId}`;
    let allRecords = [];
    let offset = null;

    do {
        const url = offset ? `${baseUrl}?offset=${offset}` : baseUrl;
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_API_KEY}` },
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Airtable error ${res.status}: ${text}`);
        }
        const data = await res.json();
        allRecords = allRecords.concat(data.records);
        offset = data.offset || null;
    } while (offset);

    return allRecords;
}

function getCutoffDate() {
    const d = new Date();
    d.setMonth(d.getMonth() - CONFIG.EXPIRY_MONTHS);
    return d;
}

function isWithinWindow(dateStr) {
    if (!dateStr) return true;
    return new Date(dateStr) >= getCutoffDate();
}

function calculateSinglesStandings(players, matches, matchTypesMap) {
    const activeMatches = matches.filter(m => isWithinWindow(m.fields['Date']));
    const pointsMap = {};
    const winsMap = {};
    const lossesMap = {};
    players.forEach(p => { pointsMap[p.id] = 0; winsMap[p.id] = 0; lossesMap[p.id] = 0; });

    activeMatches.forEach(m => {
        const mtIds = m.fields['Match Type'];
        if (!mtIds || mtIds.length === 0) return;
        const mt = matchTypesMap[mtIds[0]];
        if (!mt) return;
        const pts = mt.fields['Default Points Awarded'] || 0;

        (m.fields['Winner(s)'] || []).forEach(id => {
            pointsMap[id] = (pointsMap[id] || 0) + pts;
            winsMap[id] = (winsMap[id] || 0) + 1;
        });
        (m.fields['Loser(s)'] || []).forEach(id => {
            pointsMap[id] = (pointsMap[id] || 0) + Math.round(pts * CONFIG.LOSER_POINT_FRACTION);
            lossesMap[id] = (lossesMap[id] || 0) + 1;
        });
    });

    const standings = players.map(p => ({
        name: p.fields['Name'] || 'Unknown',
        points: pointsMap[p.id] || 0,
        wins: winsMap[p.id] || 0,
        losses: lossesMap[p.id] || 0,
    }));

    standings.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    return standings;
}

function calculateDoublesStandings(doublesTeams, doublesMatches, matchTypesMap) {
    const activeMatches = doublesMatches.filter(m => isWithinWindow(m.fields['Date']));
    const pointsMap = {};
    const winsMap = {};
    const lossesMap = {};
    doublesTeams.forEach(t => { pointsMap[t.id] = 0; winsMap[t.id] = 0; lossesMap[t.id] = 0; });

    activeMatches.forEach(m => {
        const mtIds = m.fields['Match Type'];
        if (!mtIds || mtIds.length === 0) return;
        const mt = matchTypesMap[mtIds[0]];
        if (!mt) return;
        const pts = mt.fields['Default Points Awarded'] || 0;

        (m.fields['Winner Team'] || []).forEach(id => {
            pointsMap[id] = (pointsMap[id] || 0) + pts;
            winsMap[id] = (winsMap[id] || 0) + 1;
        });
        (m.fields['Loser Team'] || []).forEach(id => {
            pointsMap[id] = (pointsMap[id] || 0) + Math.round(pts * CONFIG.LOSER_POINT_FRACTION);
            lossesMap[id] = (lossesMap[id] || 0) + 1;
        });
    });

    const standings = doublesTeams.map(t => ({
        name: t.fields['Team Name'] || 'Unknown',
        points: pointsMap[t.id] || 0,
        wins: winsMap[t.id] || 0,
        losses: lossesMap[t.id] || 0,
    }));

    standings.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    return standings;
}

async function main() {
    if (!CONFIG.AIRTABLE_API_KEY) {
        throw new Error('AIRTABLE_API_KEY environment variable is required');
    }

    console.log('Fetching data from Airtable...');
    const [players, matches, doublesTeams, doublesMatches, matchTypes] = await Promise.all([
        airtableFetch(CONFIG.TABLES.PLAYERS),
        airtableFetch(CONFIG.TABLES.MATCHES),
        airtableFetch(CONFIG.TABLES.DOUBLES_TEAMS),
        airtableFetch(CONFIG.TABLES.DOUBLES_MATCHES),
        airtableFetch(CONFIG.TABLES.MATCH_TYPES),
    ]);

    console.log(`Fetched: ${players.length} players, ${matches.length} singles matches, ${doublesTeams.length} doubles teams, ${doublesMatches.length} doubles matches, ${matchTypes.length} match types`);

    const matchTypesMap = {};
    matchTypes.forEach(r => { matchTypesMap[r.id] = r; });

    const singlesStandings = calculateSinglesStandings(players, matches, matchTypesMap);
    const doublesStandings = calculateDoublesStandings(doublesTeams, doublesMatches, matchTypesMap);

    // Build match type info for display
    const matchTypeInfo = matchTypes
        .filter(r => r.fields['Is Active'])
        .sort((a, b) => (a.fields['Default Points Awarded'] || 0) - (b.fields['Default Points Awarded'] || 0))
        .map(mt => ({
            name: mt.fields['Id'] || mt.fields['Match Type'] || 'Unknown',
            points: mt.fields['Default Points Awarded'] || 0,
        }));

    const output = {
        generatedAt: new Date().toISOString(),
        singles: singlesStandings,
        doubles: doublesStandings,
        matchTypes: matchTypeInfo,
    };

    const outPath = path.join(__dirname, 'data', 'standings.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`Wrote standings to ${outPath}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
