import Docker from "dockerode";
import { config } from "dotenv";
import express from "express";
import path from "path";
import fs from "fs";


config();

const app = express();
const PORT = process.env.EXPRESS_PORT || 3000;



// parse urlencoded bodies (for POST form submissions)
app.use(express.urlencoded({ extended: true }));

// serve static assets (CSS, client scripts, etc.) from the public folder
app.use(express.static(path.join(process.cwd(), 'public')));

// configure EJS as the view engine
app.set("view engine", "ejs");
// express will look for template files in the `views` directory by default;
// you can override it if desired but the default is fine here
// app.set('views', path.join(process.cwd(), 'views'));



const docker = new Docker({
    socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
    version: "v1.41"
});


app.get("/", async (req, res) => {

    try {
        const volumes = await docker.listVolumes();
        const message = req.query.message; // optional success/info message
     
        // render the ejs template and pass volumes as a variable
        res.render("index", { volumes, currentPage: 'home', message });
    } catch (err) {
        console.error("Error listing volumes:", err);
        res.status(500).json({ error: "Failed to list volumes" });
    }
});


// GET route for backup list page
app.get("/backup-list", async (req, res) => {
    try {
        const backupDir = "/backup";
        let backupFiles = [];
        try {
            backupFiles = fs.readdirSync(backupDir).filter(f => f !== '.gitkeep');
        } catch (err) {
            console.warn("Could not read backup directory:", err);
        }
        const message = req.query.message;
        res.render("index", { volumes: { Volumes: [] }, backupFiles, currentPage: 'backup', message });
    } catch (err) {
        console.error("Error listing backups:", err);
        res.status(500).json({ error: "Failed to list backups" });
    }
});

// route to download an individual backup file
app.get('/download/:filename', (req, res) => {
    const backupDir = '/backup';
    const filename = req.params.filename;
    // basic security: prevent directory traversal
    if (filename.includes('..') || path.isAbsolute(filename)) {
        return res.status(400).send('Invalid filename');
    }
    const filePath = path.join(backupDir, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('File not found');
    }
    res.download(filePath, filename, err => {
        if (err) {
            console.error('Error downloading file', err);
            res.status(500).send('Error downloading file');
        }
    });
});

// route to delete a backup file via GET
app.get('/delete/:filename', (req, res) => {
    const backupDir = '/backup';
    const filename = req.params.filename;
    // basic security: prevent directory traversal
    if (filename.includes('..') || path.isAbsolute(filename)) {
        return res.status(400).send('Invalid filename');
    }
    const filePath = path.join(backupDir, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('File not found');
    }
    fs.unlink(filePath, err => {
        if (err) {
            console.error('Error deleting file', err);
            return res.status(500).send('Error deleting file');
        }
        res.redirect('/backup-list?message=' + encodeURIComponent(`Deleted backup ${filename}`));
    });
});

// API endpoint to get details for a given volume
app.get('/volume/:name', async (req, res) => {
    const name = req.params.name;
    try {
        const volume = docker.getVolume(name);
        const info = await volume.inspect();
        res.json(info);
    } catch (err) {
        console.error('Error inspecting volume', err);
        res.status(500).json({ error: 'Failed to inspect volume' });
    }
});

// handle POST from the volume selection form
app.post("/backup", async (req, res) => {
    const volumeName = req.body.volume;
    if (!volumeName) {
        return res.status(400).send("No volume selected");
    }
    try {
        console.log(`Running backup for volume: ${volumeName}`);
        // Create a container that mounts the selected volume and runs a backup command
        const container = await docker.createContainer({
            Image: 'alpine',
            Cmd: ['sh', '-c', `tar -czf /backup/${volumeName}_$(date +%Y-%m-%d_%H-%M-%S).tar.gz -C /bkp_source .`],
            HostConfig: {
                Binds: [
                    `${volumeName}:/bkp_source:ro`,
                ],
                Mounts: [
                    {
                        Type: "bind",
                        Source: process.env.BKPDIR,
                        Target: "/backup",
                        ReadOnly: false
                    }
                ]
               
            },
            WorkingDir: '/bkp_source',
            Tty: false,
            AttachStderr: true,
            AttachStdout: true
        });
        await container.start();
        await container.wait();
        await container.remove();
        // redirect back to home with a success message for toast
        const successMsg = encodeURIComponent(`Backup for volume ${volumeName} completed successfully`);
        res.redirect(`/?message=${successMsg}`);
    } catch (err) {
        console.error("Error running backup:", err);
        res.status(500).send("Error running backup: " + err.message);
    }
});


app.get("/restore/:filename", async (req, res) => {

    const filename = req.params.filename;
    const volumes = await docker.listVolumes()

    res.render("index", { volumes, currentPage: 'restore', filename: filename, message: null });
    
});

app.post("/restore", async (req, res) => {

    const filename = req.body.filename;
    const mode = req.body.mode;
    let volumeName;

    // basic security: prevent directory traversal
    if (filename.includes('..') || path.isAbsolute(filename)) {
        return res.status(400).send('Invalid filename');
    }

    if (!filename) {
        return res.status(400).send("Filename is required");
    }

    if (mode === 'new') {
        volumeName = req.body.newVolumeName;
        if (!volumeName) {
            return res.status(400).send("New volume name is required");
        }
        try {
            if(await volumeExists(volumeName)) {
                return res.status(400).send("Volume with that name already exists");
            }
            await docker.createVolume({ Name: volumeName, Driver: 'local' });
            console.log(`Created new volume: ${volumeName}`);
        } catch (err) {
            console.error('Error creating volume', err);
            return res.status(500).send('Failed to create volume: ' + err.message);
        }
    } else {
        volumeName = req.body.volume;
        if (!volumeName) {
            return res.status(400).send("No volume selected");
        }
    }

    console.log(`Restoring backup ${filename} to volume: ${volumeName}`);

    try {
        // Create a container that mounts the target volume and extracts the backup
        const container = await docker.createContainer({
            Image: 'alpine',
            Cmd: ['sh', '-c', `tar -xzf /backup/${filename} -C /restore_target`],
            HostConfig: {
                Binds: [
                    `${volumeName}:/restore_target`,
                ],
                Mounts: [
                    {
                        Type: "bind",
                        Source: process.env.BKPDIR,
                        Target: "/backup",
                        ReadOnly: true
                    }
                ]
            },
            WorkingDir: '/restore_target',
            Tty: false,
            AttachStderr: true,
            AttachStdout: true
        });
        await container.start();
        await container.wait();
        await container.remove();
        res.redirect("/backup-list?message=Restore completed successfully");
    } catch (err) {
        console.error("Error running restore:", err);
        res.status(500).send("Error running restore: " + err.message);
    }
    
});

const volumeExists = async (name) => {
    const volumes = await docker.listVolumes();
    return volumes.Volumes.some(v => v.Name === name);
}

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

