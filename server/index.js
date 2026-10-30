import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const app = createApp();
app.listen(port).then((p) => console.log(`Fantasmas en el tejado escuchando en http://localhost:${p}`));
