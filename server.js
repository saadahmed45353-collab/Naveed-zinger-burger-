const express=require('express'),db=require('better-sqlite3')('data.db'),bc=require('bcryptjs'),jwt=require('jsonwebtoken');
const SECRET=process.env.JWT_SECRET||'change-this-secret',DELIVERY=150;
db.exec(`
create table if not exists users(id integer primary key,name,phone unique,password,role default 'customer',created default current_timestamp);
create table if not exists products(id integer primary key,name,description,price integer,category,image,rating real default 4.5,active integer default 1);
create table if not exists deals(id integer primary key,title,description,price integer,image,expires,active integer default 1);
create table if not exists wishlist(user_id integer,product_id integer,primary key(user_id,product_id));
create table if not exists addresses(id integer primary key,user_id integer,label,address);
create table if not exists riders(id integer primary key,name,phone,active integer default 1,lat real,lng real,updated,token text unique default (lower(hex(randomblob(6)))));
create table if not exists orders(id integer primary key,user_id integer,items,subtotal integer,delivery integer,total integer,address,status default 'placed',rider_id integer,created default current_timestamp);
`);
if(!db.prepare("select 1 from users where role='admin'").get())
  db.prepare("insert into users(name,phone,password,role) values('Admin',?,?,'admin')").run(process.env.ADMIN_PHONE||'admin',bc.hashSync(process.env.ADMIN_PASS||'admin123',10));
if(!db.prepare('select 1 from products').get()){
  const U='https://images.unsplash.com/',ins=db.prepare('insert into products(name,description,price,category,image,rating) values(?,?,?,?,?,?)');
  [['Zinger Burger','Crispy chicken, mayo, lettuce',450,'Burgers',U+'photo-1568901346375-23c9450c58cd?w=300',4.8],
   ['Double Zinger','Two crispy fillets, cheese',690,'Burgers',U+'photo-1550547660-d9450f859349?w=300',4.7],
   ['Beef Smash Burger','Juicy smashed patty',590,'Burgers',U+'photo-1561758033-d89a9ad46330?w=300',4.6],
   ['Masala Fries','Spicy loaded fries',220,'Sides',U+'photo-1573080496219-bb080dd4f877?w=300',4.4],
   ['Cold Drink 500ml','Chilled',100,'Drinks','',4.5]].forEach(r=>ins.run(...r));
  db.prepare("insert into deals(title,description,price,expires) values('Zinger Combo','Zinger + Fries + Drink',650,null)").run();
}
const app=express();app.use(express.json(),express.static('public'));
const auth=role=>(q,s,n)=>{try{q.u=jwt.verify((q.headers.authorization||'').slice(7),SECRET);if(role&&q.u.role!==role)throw 0;n()}catch{s.status(401).json({error:'Unauthorized'})}};
const tok=u=>({token:jwt.sign({id:u.id,role:u.role,name:u.name},SECRET,{expiresIn:'30d'}),user:{id:u.id,name:u.name,role:u.role}});
app.post('/api/register',(q,s)=>{const{name,phone,password}=q.body;if(!name||!phone||(password||'').length<6)return s.status(400).json({error:'Name, phone and 6+ char password required'});
  try{const id=db.prepare('insert into users(name,phone,password) values(?,?,?)').run(name,phone,bc.hashSync(password,10)).lastInsertRowid;s.json(tok({id,name,role:'customer'}))}catch{s.status(400).json({error:'Phone already registered'})}});
app.post('/api/login',(q,s)=>{const u=db.prepare('select * from users where phone=?').get(q.body.phone||'');
  if(!u||!bc.compareSync(q.body.password||'',u.password))return s.status(401).json({error:'Wrong phone or password'});s.json(tok(u))});
app.get('/api/products',(q,s)=>s.json(db.prepare('select * from products where active=1').all()));
app.get('/api/deals',(q,s)=>s.json(db.prepare("select * from deals where active=1 and (expires is null or expires='' or expires>=date('now'))").all()));
app.get('/api/wishlist',auth(),(q,s)=>s.json(db.prepare('select p.* from wishlist w join products p on p.id=w.product_id where w.user_id=?').all(q.u.id)));
app.post('/api/wishlist/:id',auth(),(q,s)=>{db.prepare('insert or ignore into wishlist values(?,?)').run(q.u.id,q.params.id);s.json({ok:1})});
app.delete('/api/wishlist/:id',auth(),(q,s)=>{db.prepare('delete from wishlist where user_id=? and product_id=?').run(q.u.id,q.params.id);s.json({ok:1})});
app.get('/api/addresses',auth(),(q,s)=>s.json(db.prepare('select * from addresses where user_id=?').all(q.u.id)));
app.post('/api/addresses',auth(),(q,s)=>{db.prepare('insert into addresses(user_id,label,address) values(?,?,?)').run(q.u.id,q.body.label||'Home',q.body.address);s.json({ok:1})});
app.delete('/api/addresses/:id',auth(),(q,s)=>{db.prepare('delete from addresses where id=? and user_id=?').run(q.params.id,q.u.id);s.json({ok:1})});
app.post('/api/orders',auth(),(q,s)=>{const its=[];let sub=0;
  for(const i of q.body.items||[]){const x=db.prepare(i.type=='d'?'select title name,price from deals where id=? and active=1':'select name,price from products where id=? and active=1').get(i.id);
    if(!x)return s.status(400).json({error:'An item is no longer available'});const n=Math.max(1,i.qty|0);sub+=x.price*n;its.push({name:x.name,qty:n,price:x.price})}
  if(!its.length||!q.body.address)return s.status(400).json({error:'Cart and address required'});
  const id=db.prepare('insert into orders(user_id,items,subtotal,delivery,total,address) values(?,?,?,?,?,?)').run(q.u.id,JSON.stringify(its),sub,DELIVERY,sub+DELIVERY,q.body.address).lastInsertRowid;
  s.json({id,subtotal:sub,delivery:DELIVERY,total:sub+DELIVERY})});
app.get('/api/orders',auth(),(q,s)=>s.json(db.prepare('select * from orders where user_id=? order by id desc').all(q.u.id)));
app.get('/api/orders/:id/track',auth(),(q,s)=>{const t=db.prepare('select o.status,r.name rider,r.lat,r.lng from orders o left join riders r on r.id=o.rider_id where o.id=? and o.user_id=?').get(q.params.id,q.u.id);t?s.json(t):s.status(404).json({error:'Not found'})});
app.post('/api/rider/location',(q,s)=>{const r=db.prepare('update riders set lat=?,lng=?,updated=datetime("now") where token=? and active=1').run(q.body.lat,q.body.lng,q.body.token);r.changes?s.json({ok:1}):s.status(403).json({error:'Invalid rider token'})});
const crud=(t,cols)=>{const r=express.Router();r.use(auth('admin'));
  r.get('/',(q,s)=>s.json(db.prepare(`select * from ${t} order by id desc`).all()));
  r.post('/',(q,s)=>s.json({id:db.prepare(`insert into ${t}(${cols}) values(${cols.map(()=>'?')})`).run(cols.map(c=>q.body[c]??null)).lastInsertRowid}));
  r.put('/:id',(q,s)=>{db.prepare(`update ${t} set ${cols.map(c=>c+'=?')} where id=?`).run([...cols.map(c=>q.body[c]??null),q.params.id]);s.json({ok:1})});
  r.delete('/:id',(q,s)=>{db.prepare(`delete from ${t} where id=?`).run(q.params.id);s.json({ok:1})});return r};
app.use('/api/admin/products',crud('products',['name','description','price','category','image','rating','active']));
app.use('/api/admin/deals',crud('deals',['title','description','price','image','expires','active']));
app.use('/api/admin/riders',crud('riders',['name','phone','active']));
app.get('/api/admin/orders',auth('admin'),(q,s)=>s.json(db.prepare('select o.*,u.name cname,u.phone from orders o left join users u on u.id=o.user_id order by o.id desc').all()));
app.put('/api/admin/orders/:id',auth('admin'),(q,s)=>{db.prepare('update orders set status=?,rider_id=? where id=?').run(q.body.status,q.body.rider_id,q.params.id);s.json({ok:1})});
app.get('/api/admin/customers',auth('admin'),(q,s)=>s.json(db.prepare("select u.name,u.phone,u.created,(select count(*) from orders where user_id=u.id) orders from users u where role='customer' order by u.id desc").all()));
app.listen(process.env.PORT||3000,()=>console.log('Running on http://localhost:'+(process.env.PORT||3000)));
