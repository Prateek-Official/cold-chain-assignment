import { hashPassword } from './auth.js';

// Demo data, inserted only into an empty database.
// Logins:  dispatcher/dispatch123   driver1/driver123 (Asha)   driver2/driver123 (Ravi)
export function seedIfEmpty(db, nowMs = Date.now()) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;

  const addUser = db.prepare('INSERT INTO users (username, name, role, password_hash) VALUES (?,?,?,?)');
  addUser.run('dispatcher', 'Dana Dispatcher', 'dispatcher', hashPassword('dispatch123'));
  const asha = Number(addUser.run('driver1', 'Asha Rao', 'driver', hashPassword('driver123')).lastInsertRowid);
  const ravi = Number(addUser.run('driver2', 'Ravi Kumar', 'driver', hashPassword('driver123')).lastInsertRowid);

  const addDevice = db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)');
  for (let i = 1; i <= 10; i++) {
    const id = `TRK-${String(i).padStart(2, '0')}`;
    addDevice.run(id, `Reefer truck ${id}`);
  }

  const startedAgo = new Date(nowMs - 20 * 60 * 1000).toISOString();
  const addTrip = db.prepare(
    'INSERT INTO trips (id, device_id, driver_id, cargo, origin, destination, status, started_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  const trips = [
    // id, device, driver, cargo, origin, destination, status
    ['T-1', 'TRK-01', asha, 'Vaccines (COVID booster)', 'Mumbai Hub', 'Pune City Hospital', 'IN_PROGRESS'],
    ['T-2', 'TRK-02', asha, 'Frozen seafood', 'Mumbai Port', 'Nashik Cold Store', 'IN_PROGRESS'],
    ['T-3', 'TRK-03', asha, 'Dairy (milk, curd)', 'Pune Dairy', 'Satara Market', 'ASSIGNED'],
    ['T-4', 'TRK-04', asha, 'Insulin pens', 'Mumbai Hub', 'Thane Pharmacy', 'ASSIGNED'],
    ['T-5', 'TRK-05', asha, 'Ice cream', 'Pune Plant', 'Kolhapur Outlets', 'ASSIGNED'],
    ['T-6', 'TRK-06', ravi, 'Blood samples', 'Nagpur Lab', 'Wardha Clinic', 'IN_PROGRESS'],
    ['T-7', 'TRK-07', ravi, 'Vaccines (MMR)', 'Nagpur Hub', 'Amravati PHC', 'IN_PROGRESS'],
    ['T-8', 'TRK-08', ravi, 'Fresh produce', 'Nashik Farms', 'Mumbai APMC', 'ASSIGNED'],
    ['T-9', 'TRK-09', ravi, 'Paneer & cheese', 'Pune Dairy', 'Mumbai Retail', 'ASSIGNED'],
    ['T-10', 'TRK-10', ravi, 'Biologics', 'Hyderabad Hub', 'Warangal Hospital', 'ASSIGNED'],
  ];
  for (const [id, dev, drv, cargo, from, to, status] of trips) {
    addTrip.run(id, dev, drv, cargo, from, to, status, status === 'IN_PROGRESS' ? startedAgo : null);
  }
  return true;
}
