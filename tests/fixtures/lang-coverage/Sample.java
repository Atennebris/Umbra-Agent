import java.util.List;
import java.util.ArrayList;

public class Sample {
    private String name;

    public Sample(String name) {
        this.name = name;
    }

    public String getName() {
        return this.name;
    }

    public static void main(String[] args) {
        Sample s = new Sample("umbra");
        System.out.println(s.getName());
    }
}

interface Runnable {
    void run();
}

enum Status {
    ACTIVE, INACTIVE, PENDING
}
