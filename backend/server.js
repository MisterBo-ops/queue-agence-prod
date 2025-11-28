require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const exceljs = require('exceljs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI).then(() => console.log('MongoDB connecté'));

// ────────────────── Modèles ──────────────────
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  role: { type: String, enum: ['admin','accueil','conseiller','teamleader','chef'] }
});
const User = mongoose.model('User', UserSchema);

const ClientSchema = new mongoose.Schema({
  nom: String, prenom: String, telephone: String, raison: String, secondContact: String,
  enregistrement: { type: Date, default: Date.now },
  debutAttente: { type: Date, default: Date.now },
  finAttente: Date, debutConseil: Date, finConseil: Date,
  conseiller: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, default: 'en_attente' } // en_attente, en_cours, termine
});
const Client = mongoose.model('Client', ClientSchema);

// ────────────────── Admin auto ──────────────────
User.findOne({ username: 'admin' }).then(async admin => {
  if (!admin) {
    const hash = await bcrypt.hash('admin123', 10);
    await new User({ username: 'admin', password: hash, role: 'admin' }).save();
    console.log('Admin créé → admin / admin123');
  }
});

// ────────────────── Routes ──────────────────
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Mauvais identifiants' });
  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret2025', { expiresIn: '24h' });
  res.json({ token, role: user.role });
});

app.post('/register', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret2025');
  const current = await User.findById(decoded.id);
  if (current.role !== 'admin') return res.status(403).json({ error: 'Admin seulement' });

  const { username, password, role } = req.body;
  const hash = await bcrypt.hash(password, 10);
  await new User({ username, password: hash, role }).save();
  res.json({ message: 'Créé' });
});

app.post('/clients', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret2025');
  const user = await User.findById(decoded.id);
  if (user.role !== 'accueil') return res.status(403).json({ error: 'Accès refusé' });

  const client = new Client(req.body);
  await client.save();
  io.emit('nouveau_client', client);
  res.json(client);
});

app.get('/clients', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  jwt.verify(token, process.env.JWT_SECRET || 'secret2025');
  const clients = await Client.find().populate('conseiller', 'username');
  res.json(clients);
});

app.put('/clients/:id/prendre', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret2025');
  const user = await User.findById(decoded.id);
  if (user.role !== 'conseiller') return res.status(403).json({ error: 'Accès refusé' });

  const client = await Client.findByIdAndUpdate(req.params.id, {
    finAttente: new Date(),
    debutConseil: new Date(),
    conseiller: user._id,
    status: 'en_cours'
  }, { new: true }).populate('conseiller');

  io.emit('client_pris', client);

  // Alerte 35 min
  setTimeout(async () => {
    const c = await Client.findById(req.params.id);
    if (c.status === 'en_cours') io.emit('alerte_longue', c);
  }, 35 * 60 * 1000);

  res.json(client);
});

app.put('/clients/:id/terminer', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret2025');
  const user = await User.findById(decoded.id);
  if (user.role !== 'conseiller') return res.status(403).json({ error: 'Accès refusé' });

  const client = await Client.findByIdAndUpdate(req.params.id, {
    finConseil: new Date(),
    status: 'termine'
  }, { new: true });
  io.emit('client_termine', client);
  res.json(client);
});

app.get('/rapport', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret2025');
  const user = await User.findById(decoded.id);
  if (!['teamleader','chef','admin'].includes(user.role)) return res.status(403).json({ error: 'Refusé' });

  const clients = await Client.find({ status: 'termine' }).populate('conseiller', 'username');
  const workbook = new exceljs.Workbook();
  const sheet = workbook.addWorksheet('Rapport');
  sheet.columns = [
    { header: 'Nom', key: 'nom' },
    { header: 'Prénom', key: 'prenom' },
    { header: 'Téléphone', key: 'telephone' },
    { header: 'Raison', key: 'raison' },
    { header: 'Second contact', key: 'secondContact' },
    { header: 'Conseiller', key: 'conseiller' },
    { header: 'Attente (min)', key: 'attente' },
    { header: 'Conseil (min)', key: 'conseil' }
  ];
  clients.forEach(c => {
    const attente = c.finAttente ? Math.round((new Date(c.finAttente) - new Date(c.debutAttente))/60000) : 0;
    const conseil = c.finConseil ? Math.round((new Date(c.finConseil) - new Date(c.debutConseil))/60000) : 0;
    sheet.addRow({ nom: c.nom, prenom: c.prenom, telephone: c.telephone, raison: c.raison, secondContact: c.secondContact,
      conseiller: c.conseiller?.username || '-', attente, conseil });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=rapport.xlsx');
  await workbook.xlsx.write(res);
  res.end();
});

io.on('connection', socket => console.log('Socket connecté'));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Serveur sur port ${PORT}`));
