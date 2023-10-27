import express from 'express';
import fs from 'fs';
import path from 'path'
import https from 'https';
import { v4 as uuidv4 } from 'uuid';
import bodyParser from 'body-parser';
import {Pool} from 'pg';
import { auth, requiresAuth } from 'express-openid-connect'; 
import dotenv from 'dotenv'
dotenv.config()

const app = express();
app.use(express.json());
app.use(express.urlencoded({extended: true}));
app.set("views", path.join(__dirname, "views"));
app.set('view engine', 'pug');

const port = 4010;

const pool = new Pool({
  user: 'ferweb',
  host: 'frankfurt-postgres.render.com',
  database: 'tjukic_tournament',
  password: 'igvrjDkqFlLe4e4wMdnzlJXv7n9qg6Y8',
  port: 5432,
  ssl: {
    rejectUnauthorized: false // Add this line if your SSL certificate is self-signed or not fully trusted
  }
});

const config = { 
  authRequired : false,
  idpLogout : true, //login not only from the app, but also from identity provider
  secret: process.env.SECRET,
  baseURL: `https://localhost:${port}`,
  clientID: process.env.CLIENT_ID,
  issuerBaseURL: 'https://tomijuki.eu.auth0.com',
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
    const { leaguename, teamnames, winpoints, tiepoints, losspoints} = req.body;
    const leagueid = uuidv4();
    console.log(leaguename, leagueid, req.oidc.user?.nickname, winpoints, tiepoints, losspoints);
    // Insert the league name into the leagues table
    await client.query('INSERT INTO leagues (leagueid, leaguename, ownerusername, winpoints, tiepoints, losspoints) VALUES ($1, $2, $3, $4, $5, $6)', [
      leagueid,
      leaguename,
      req.oidc.user?.nickname,
      winpoints,
      tiepoints,
      losspoints
    ]);

    

    console.log(teamnames);
    // Split the team names into an array
    const teams = teamnames.split(/,|\n/);


    // Create matches for each pair of teams
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        await client.query('INSERT INTO matches (matchid, team1, team2, team1score, team2score, leagueid) VALUES ($1, $2, $3, $4, $5, $6)', [
          uuidv4(),
          teams[i].trim(),
          teams[j].trim(),
          null,
          null,
          leagueid
        ]);
      }
    }

    client.release();
    res.redirect(`/matches/${leaguename}`);
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});

interface Standing {
  points: number;
}

/*app.get('/leagues', requiresAuth(), async (req, res) => {
  try{}
});*/

app.get('/matches/:league', requiresAuth(), async (req, res) => {
  try {
    let username;
    if (req.oidc.isAuthenticated()) {
      username = req.oidc.user?.nickname;
    }

    const { league } = req.params;
    const client = await pool.connect();

    // Retrieve the owner ID associated with the league
    const ownerResult = await client.query('SELECT ownerusername, winpoints, tiepoints, losspoints FROM leagues WHERE leaguename = $1', [league]);
    const ownerUsername = ownerResult.rows[0].ownerusername;
    const winpoints = ownerResult.rows[0].winpoints;
    const tiepoints = ownerResult.rows[0].tiepoints;  
    const losspoints = ownerResult.rows[0].losspoints;

    // Compare the username with the owner ID to check for access permission
    if (username !== ownerUsername) {
      // Redirect or render an error page if access is not permitted
      return res.render('error', { message: 'You do not have permission to access this tournament.' });
    }
    const result = await client.query('SELECT matchid, team1, team2, team1score, team2score FROM matches WHERE leagueid = (SELECT leagueid FROM leagues WHERE leaguename = $1) ORDER BY matchid ASC', [league]);
    const matches = result.rows;
    
    console.log(matches);

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

    res.render('matches', { matches, standings: sortedStandings, league });
    client.release();
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});

app.post('/matches/:league/:matchid', async (req, res) => {
  try {
    const { league, matchid } = req.params;
    const { team1score, team2score } = req.body;
    const client = await pool.connect();

    await client.query('UPDATE matches SET team1score = $1, team2score = $2 WHERE matchid = $3', [
      team1score,
      team2score,
      matchid,
    ]);

    client.release();
    res.redirect(`/matches/${league}`);
  } catch (err) {
    console.error(err);
    res.send('Error ' + err);
  }
});

https.createServer({
    key: fs.readFileSync('server.key'),
    cert: fs.readFileSync('server.cert')
  }, app)
  .listen(port, function () {
    console.log(`Server running at https://localhost:${port}/`);
  });