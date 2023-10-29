import express from 'express';
import path from 'path'
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import {Pool} from 'pg';
import { auth, requiresAuth } from 'express-openid-connect'; 
import dotenv from 'dotenv'
dotenv.config()

const app = express();
app.use(express.json());
app.use(express.urlencoded({extended: true}));
app.set("views", path.join(__dirname, "views"));
app.set('view engine', 'pug');


const port = process.env.PORT || 3000;

const pool = new Pool({
  user: process.env.DB_USER,
  host: 'frankfurt-postgres.render.com',
  database: 'tjukic_tournament',
  password: process.env.DB_PASSWORD,
  port: 5432,
  ssl: {
    rejectUnauthorized: false // Add this line if your SSL certificate is self-signed or not fully trusted
  }
});

const config = { 
  authRequired : false,
  idpLogout : true, //login not only from the app, but also from identity provider
  secret: process.env.SECRET,
  baseURL: `${process.env.BASE_URL}`,
  clientID: process.env.CLIENT_ID,
  issuerBaseURL: `${process.env.ISSUER_BASE_URL}`,
  clientSecret: process.env.CLIENT_SECRET,
  authorizationParams: {
    response_type: 'code' ,
    //scope: "openid profile email"   
   },
};
// auth router attaches /login, /logout, and /callback routes to the baseURL
app.use(auth(config));

app.get('/',  function (req, res) {
  let username : string | undefined;
  if (req.oidc.isAuthenticated()) {
    username = req.oidc.user?.name ?? req.oidc.user?.sub;
  }
  res.render('index', {username});
});

app.get('/creator', requiresAuth(), function (req, res) {       
    const user = JSON.stringify(req.oidc.user);      
    res.render('creator', {user}); 
});

app.get("/sign-up", (req, res) => {
  res.oidc.login({
    returnTo: '/',
    authorizationParams: {      
      screen_hint: "signup",
    },
  });
});

app.post('/create-league', requiresAuth(), async (req, res) => {
  try {
    const client = await pool.connect();
    const { leaguename, teamnames, winpoints, tiepoints, losspoints } = req.body;
    const leagueid = uuidv4();
    let teams = teamnames.split(/,|\n/);

    // If the number of teams is odd, add a 'bye' team to ensure even numbers
    if (teams.length % 2 !== 0) {
      teams.push('Bye');
    }

    const numTeams = teams.length;
    const matchesByMatchday: { [key: string]: string[] } = {};

    // Insert the league name into the leagues table
    await client.query('INSERT INTO leagues (leagueid, leaguename, ownerusername, winpoints, tiepoints, losspoints, shared) VALUES ($1, $2, $3, $4, $5, $6, false)', [
      leagueid,
      leaguename.trim().toLowerCase().replace(/\s+/g, '-'),
      req.oidc.user?.nickname,
      winpoints,
      tiepoints,
      losspoints
    ]);

    const totalRounds = numTeams - 1;
    const matchesPerRound = numTeams / 2;

    for (let round = 0; round < totalRounds; round++) {
      const matchdayCount = round + 1;
      matchesByMatchday[matchdayCount.toString()] = [];

      for (let i = 0; i < matchesPerRound; i++) {
        const team1 = teams[i];
        const team2 = teams[numTeams - 1 - i];

        if (team1 !== 'Bye' && team2 !== 'Bye') {
          matchesByMatchday[matchdayCount.toString()].push(team1, team2);

          await client.query('INSERT INTO matches (matchid, team1, team2, team1score, team2score, leagueid, matchday) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
            uuidv4(),
            team1,
            team2,
            null,
            null,
            leagueid,
            matchdayCount
          ]);
        }
      }

      // Rotate the teams, except for the first team
      const firstTeam = teams.shift();
      teams.push(teams.shift());
      teams.unshift(firstTeam);
    }

    client.release();
    res.redirect(`/leagues/${leaguename.trim().toLowerCase().replace(/\s+/g, '-')}`);
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});

interface Standing {
  points: number;
}

app.get('/leagues', requiresAuth(), async (req, res) => {
  try{
    const client = await pool.connect();
    let username;
    if (req.oidc.isAuthenticated()) {
      username = req.oidc.user?.nickname;
    }
    const result = await client.query('SELECT leagueid, leaguename, ownerusername FROM leagues WHERE ownerusername = $1', [username]);
    const leagues = result.rows;
    res.render('leagues', {leagues, username} );
    client.release();
  } catch (err) { 
    console.error(err);
    res.send('Error ' + err);
  }});
  
app.get('/leagues/drop/:leagueid', requiresAuth(), async (req, res) => {
  try {
    const client = await pool.connect();
    const leagueId = req.params.leagueid;
  
    const resultMatches =await client.query('DELETE FROM matches WHERE leagueid = $1', [leagueId]);
    const resultLeagues = await client.query('DELETE FROM leagues WHERE leagueid = $1', [leagueId]);
    client.release();
    res.redirect('/leagues');
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});

app.get('/leagues/:league', requiresAuth(), async (req, res) => {
  try {
    let username;
    if (req.oidc.isAuthenticated()) {
      username = req.oidc.user?.nickname;
    }

    const { league } = req.params;
    const client = await pool.connect();

    // Retrieve the owner ID associated with the league
    const ownerResult = await client.query('SELECT ownerusername, winpoints, tiepoints, losspoints, shared FROM leagues WHERE leaguename = $1', [league]);
    const ownerUsername = ownerResult.rows[0].ownerusername;
    const winpoints = ownerResult.rows[0].winpoints;
    const tiepoints = ownerResult.rows[0].tiepoints;  
    const losspoints = ownerResult.rows[0].losspoints;
    const shared = ownerResult.rows[0].shared;

    // Compare the username with the owner ID to check for access permission
    if (username !== ownerUsername) {
      // Redirect or render an error page if access is not permitted
      return res.render('error', { message: 'You do not have permission to access this tournament.' });
    }
    const result = await client.query('SELECT matchid, team1, team2, team1score, team2score, matchday FROM matches WHERE leagueid = (SELECT leagueid FROM leagues WHERE leaguename = $1) ORDER BY matchid ASC', [league]);
    const matches = result.rows;
    const matchdaysCount = await client.query('SELECT MAX(matchday) FROM matches WHERE leagueid = (SELECT leagueid FROM leagues WHERE leaguename = $1)', [league]);
    const matchdays = [];
    for (let i = 1; i <= matchdaysCount.rows[0].max; i++) {
      matchdays.push(i);
    };

    const standings: Record<string, Standing & { wins: number; draws: number; losses: number }> = {};
    matches.forEach((match) => {
      standings[match.team1] = standings[match.team1] || { points: 0, wins: 0, draws: 0, losses: 0 };
      standings[match.team2] = standings[match.team2] || { points: 0, wins: 0, draws: 0, losses: 0 };

      if (match.team1score !== null && match.team2score !== null) {
        const winpointsValue = parseFloat(winpoints);
        const tiepointsValue = parseFloat(tiepoints);
        const losspointsValue = parseFloat(losspoints);
    
        if (match.team1score > match.team2score) {
            standings[match.team1].points += winpointsValue;
            standings[match.team1].wins += 1;
            standings[match.team2].losses += 1;
            if (losspointsValue !== 0) standings[match.team2].points += losspointsValue;
        } else if (match.team1score === match.team2score) {
            standings[match.team1].points += tiepointsValue;
            standings[match.team1].draws += 1;
            standings[match.team2].points += tiepointsValue;
            standings[match.team2].draws += 1;
        } else {
            standings[match.team2].points += winpointsValue;
            standings[match.team2].wins += 1;
            standings[match.team1].losses += 1;
            if (losspointsValue !== 0) standings[match.team1].points += losspointsValue;
        }
    }
    });

    const sortedStandings = Object.entries(standings).sort((a, b) => b[1].points - a[1].points);
    
    res.render('matches', { matchdays, matches, standings: sortedStandings, league, shared });
    client.release();
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});

app.post('/leagues/:league/:matchid', requiresAuth(), async (req, res) => {
  try {
    const { league, matchid } = req.params;
    const { team1score, team2score } = req.body;
    const client = await pool.connect();

    await client.query('UPDATE matches SET team1score = $1, team2score = $2 WHERE matchid = $3', [
      team1score,
      team2score,
      matchid
    ]);

    client.release();
    res.redirect(`/leagues/${league}`);
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});

app.post('/leagues/share', requiresAuth(), async (req, res) => {
  try {
    const client = await pool.connect();
    const league = req.body.league;
    
    // Retrieve the league ID (UUID) based on the league name
    const leagueResult = await client.query('SELECT leagueid FROM leagues WHERE leaguename = $1', [league]);
    const leagueId = leagueResult.rows[0].leagueid;

    // Use the league ID to perform the update
    await client.query('UPDATE leagues SET shared = true WHERE leagueid = $1', [leagueId]);
    client.release();
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});




app.get('/shared/:league', async (req, res) => {
  try {
    const { league } = req.params;
    const client = await pool.connect();

    // Check if the league is marked for sharing
    const isLeagueShared = await checkLeagueSharing(client, league);

    if (isLeagueShared) {
      const { league } = req.params;

      // Retrieve the owner ID associated with the league
      const ownerResult = await client.query('SELECT winpoints, tiepoints, losspoints FROM leagues WHERE leaguename = $1', [league]);

      const winpoints = ownerResult.rows[0].winpoints;
      const tiepoints = ownerResult.rows[0].tiepoints;  
      const losspoints = ownerResult.rows[0].losspoints;

      const result = await client.query('SELECT matchid, team1, team2, team1score, team2score, matchday FROM matches WHERE leagueid = (SELECT leagueid FROM leagues WHERE leaguename = $1) ORDER BY matchid ASC', [league]);
      const matches = result.rows;
      const matchdaysCount = await client.query('SELECT MAX(matchday) FROM matches WHERE leagueid = (SELECT leagueid FROM leagues WHERE leaguename = $1)', [league]);
      const matchdays = [];
      for (let i = 1; i <= matchdaysCount.rows[0].max; i++) {
        matchdays.push(i);
      };

      const standings: Record<string, Standing & { wins: number; draws: number; losses: number }> = {};
      matches.forEach((match) => {
        standings[match.team1] = standings[match.team1] || { points: 0, wins: 0, draws: 0, losses: 0 };
        standings[match.team2] = standings[match.team2] || { points: 0, wins: 0, draws: 0, losses: 0 };

        if (match.team1score !== null && match.team2score !== null) {
          const winpointsValue = parseFloat(winpoints);
          const tiepointsValue = parseFloat(tiepoints);
          const losspointsValue = parseFloat(losspoints);
      
          if (match.team1score > match.team2score) {
              standings[match.team1].points += winpointsValue;
              standings[match.team1].wins += 1;
              standings[match.team2].losses += 1;
              if (losspointsValue !== 0) standings[match.team2].points += losspointsValue;
          } else if (match.team1score === match.team2score) {
              standings[match.team1].points += tiepointsValue;
              standings[match.team1].draws += 1;
              standings[match.team2].points += tiepointsValue;
              standings[match.team2].draws += 1;
          } else {
              standings[match.team2].points += winpointsValue;
              standings[match.team2].wins += 1;
              standings[match.team1].losses += 1;
              if (losspointsValue !== 0) standings[match.team1].points += losspointsValue;
          }
      }
      });

      const sortedStandings = Object.entries(standings).sort((a, b) => b[1].points - a[1].points);
      
      res.render('shared', { matchdays, matches, standings: sortedStandings, league});
    } else {
      res.send('ERROR: This league is not marked for sharing.');
    }
    client.release();
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});

async function checkLeagueSharing(client: any, league: string): Promise<boolean> {
  const result = await client.query('SELECT shared FROM leagues WHERE leaguename = $1', [league]);
  const isLeagueShared: boolean = result.rows[0].shared ?? false;
  return isLeagueShared;
}

http.createServer(app).listen(process.env.PORT || 3000, () => {
  console.log(`Server started on port ${process.env.PORT || 3000}`);
});